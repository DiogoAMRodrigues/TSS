const express = require("express");
const { ethers } = require("ethers");
const { buildChallenge, verifySignedChallenge } = require("../services/challengeService");
const { kycCases, users, toKey, writeAudit, persistNow } = require("../state/store");
const { ROLES } = require("../security/auth");

function toUnixAfterDays(days) {
  const value = Number(days);
  return Math.floor(Date.now() / 1000) + Math.max(1, value) * 24 * 60 * 60;
}

function parseAttestationDays(days, fallback) {
  const raw = days === undefined ? fallback : days;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error("attestationDays must be an integer between 1 and 3650");
  }
  return value;
}

function parsePositiveInt(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function createKycRouter({ identityClient, providerAdapter, config, auth, rateLimiters, reconciliationService }) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const noLimit = (req, res, next) => next();
  const requireAuth = auth?.requireAuth || (() => noAuth);
  const globalLimiter = rateLimiters?.globalLimiter || noLimit;
  const challengeLimiter = rateLimiters?.challengeLimiter || noLimit;
  const verifyLimiter = rateLimiters?.verifyLimiter || noLimit;

  router.use(globalLimiter);

  router.get("/health", async (req, res) => {
    const operator = identityClient.signer.address;
    res.json({
      ok: true,
      provider: providerAdapter.name,
      operator,
      identityAddress: identityClient.contract.target,
    });
  });

  router.post("/request", requireAuth([ROLES.CLIENT, ROLES.OPERATOR]), challengeLimiter, async (req, res) => {
    try {
      const { walletAddress, requestedRole = "TRADER", identityData = {} } = req.body || {};
      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "Valid walletAddress is required" });
      }

      const challenge = buildChallenge(walletAddress, config.challengeTtlSeconds);
      const key = toKey(walletAddress);
      const existing = users.get(key) || {};

      kycCases.set(key, {
        walletAddress,
        requestedRole,
        identityData,
        status: "pending_signature",
        createdAt: new Date().toISOString(),
        previousRole: existing.role || null,
      });

      writeAudit({ action: "kyc_request_created", walletAddress, requestedRole });
      persistNow();

      return res.json({
        walletAddress,
        requestedRole,
        challengeMessage: challenge.message,
        challengeExpiresAt: new Date(challenge.expiresAt).toISOString(),
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post("/verify", requireAuth([ROLES.CLIENT, ROLES.OPERATOR]), verifyLimiter, async (req, res) => {
    try {
      const { walletAddress, signature, attestationDays = config.attestationDays } = req.body || {};
      const parsedAttestationDays = parseAttestationDays(attestationDays, config.attestationDays);
      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "Valid walletAddress is required" });
      }
      if (!signature) {
        return res.status(400).json({ error: "signature is required" });
      }

      verifySignedChallenge(walletAddress, signature);

      const key = toKey(walletAddress);
      const caseData = kycCases.get(key);
      if (!caseData) {
        return res.status(400).json({ error: "No pending KYC request" });
      }

      const result = await providerAdapter.verifyIdentity({
        walletAddress,
        requestedRole: caseData.requestedRole,
        identityData: caseData.identityData,
      });

      if (!result.approved) {
        caseData.status = "rejected";
        caseData.rejectionReason = result.reason || "Verification failed";
        kycCases.set(key, caseData);
        writeAudit({ action: "kyc_rejected", walletAddress, reason: caseData.rejectionReason });
        persistNow();
        return res.status(403).json({ approved: false, reason: caseData.rejectionReason });
      }

      const role = result.role || caseData.requestedRole;
      const whitelistTx = await identityClient.whitelist(walletAddress, role);

      let attestationTx = null;
      let expiryUnixSeconds = null;

      const easy = await identityClient.prefersEasyReverification(walletAddress);
      if (easy) {
        expiryUnixSeconds = toUnixAfterDays(parsedAttestationDays);
        attestationTx = await identityClient.updateAttestation(walletAddress, expiryUnixSeconds);
      }

      const userRecord = {
        walletAddress,
        role: whitelistTx.role,
        provider: result.provider,
        evidenceId: result.evidenceId,
        easyReverification: easy,
        kycStatus: "approved",
        updatedAt: new Date().toISOString(),
        offchainNextReviewAt: easy
          ? null
          : new Date(Date.now() + parsedAttestationDays * 24 * 60 * 60 * 1000).toISOString(),
      };
      users.set(key, userRecord);
      caseData.status = "approved";
      caseData.completedAt = new Date().toISOString();
      kycCases.set(key, caseData);

      writeAudit({
        action: "kyc_approved",
        walletAddress,
        role: whitelistTx.role,
        whitelistTxHash: whitelistTx.txHash,
        attestationTxHash: attestationTx?.txHash || null,
      });
      persistNow();

      return res.json({
        approved: true,
        role: whitelistTx.role,
        whitelistTx,
        attestationTx,
        expiryUnixSeconds,
        offchainNextReviewAt: userRecord.offchainNextReviewAt,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/reverify", requireAuth([ROLES.CLIENT, ROLES.OPERATOR]), verifyLimiter, async (req, res) => {
    try {
      const { walletAddress, requestedRole, identityData = {}, attestationDays = config.attestationDays } = req.body || {};
      const parsedAttestationDays = parseAttestationDays(attestationDays, config.attestationDays);

      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "Valid walletAddress is required" });
      }

      const key = toKey(walletAddress);
      const existing = users.get(key);
      const easy = await identityClient.prefersEasyReverification(walletAddress);

      if (easy) {
        const expiryUnixSeconds = toUnixAfterDays(parsedAttestationDays);
        const attestationTx = await identityClient.updateAttestation(walletAddress, expiryUnixSeconds);

        users.set(key, {
          ...(existing || {}),
          walletAddress,
          easyReverification: true,
          updatedAt: new Date().toISOString(),
        });

        writeAudit({ action: "reverify_easy", walletAddress, attestationTxHash: attestationTx.txHash });
        persistNow();
        return res.json({ mode: "easy", attestationTx, expiryUnixSeconds });
      }

      const result = await providerAdapter.verifyIdentity({
        walletAddress,
        requestedRole: requestedRole || existing?.role || "TRADER",
        identityData,
      });

      if (!result.approved) {
        writeAudit({ action: "reverify_strict_rejected", walletAddress, reason: result.reason || "Verification failed" });
        persistNow();
        return res.status(403).json({ approved: false, reason: result.reason || "Verification failed" });
      }

      const whitelistTx = await identityClient.whitelist(walletAddress, result.role);
      const nextReviewAt = new Date(Date.now() + parsedAttestationDays * 24 * 60 * 60 * 1000).toISOString();

      users.set(key, {
        ...(existing || {}),
        walletAddress,
        role: result.role,
        provider: result.provider,
        evidenceId: result.evidenceId,
        easyReverification: false,
        kycStatus: "approved",
        offchainNextReviewAt: nextReviewAt,
        updatedAt: new Date().toISOString(),
      });

      writeAudit({ action: "reverify_strict_approved", walletAddress, whitelistTxHash: whitelistTx.txHash });
      persistNow();
      return res.json({ mode: "strict", whitelistTx, offchainNextReviewAt: nextReviewAt });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.post("/revoke", requireAuth([ROLES.OPERATOR]), async (req, res) => {
    try {
      const { walletAddress, reason = "manual_revoke" } = req.body || {};
      if (!walletAddress || !ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "Valid walletAddress is required" });
      }

      const revokeTx = await identityClient.revoke(walletAddress);
      const key = toKey(walletAddress);
      const existing = users.get(key) || {};
      users.set(key, {
        ...existing,
        walletAddress,
        kycStatus: "revoked",
        updatedAt: new Date().toISOString(),
      });

      writeAudit({ action: "revoked", walletAddress, reason, txHash: revokeTx.txHash });
      persistNow();
      return res.json({ revoked: true, revokeTx });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  router.get("/users", requireAuth([ROLES.OPERATOR, ROLES.REGULATOR]), (req, res) => {
    try {
      const allUsers = [];
      for (const [key, record] of users.entries()) {
        allUsers.push({ walletAddress: record.walletAddress || key, ...record });
      }
      return res.json({ total: allUsers.length, users: allUsers });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/users/:walletAddress", requireAuth([ROLES.OPERATOR, ROLES.REGULATOR]), async (req, res) => {
    try {
      const walletAddress = req.params.walletAddress;
      if (!ethers.isAddress(walletAddress)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      const key = toKey(walletAddress);
      const local = users.get(key) || null;
      const onChainWhitelisted = await identityClient.isWhitelisted(walletAddress);

      return res.json({
        walletAddress,
        local,
        onChainWhitelisted,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/audit", requireAuth([ROLES.OPERATOR, ROLES.REGULATOR]), (req, res) => {
    const limit = Math.min(200, parsePositiveInt(req.query.limit, 50) || 50);
    const start = parsePositiveInt(req.query.offset, 0);
    const allEntries = require("../state/store").auditLog;
    const reversed = [...allEntries].reverse();
    const entries = reversed.slice(start, start + limit);
    return res.json({ total: allEntries.length, entries });
  });

  router.post("/reconcile", requireAuth([ROLES.OPERATOR]), async (req, res) => {
    if (!reconciliationService) {
      return res.status(501).json({ error: "Reconciliation service not configured" });
    }

    try {
      const result = await reconciliationService.reconcileOnce();
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(500).json({ error: `Reconciliation failed: ${error.message}. Ensure smart contracts are deployed and configured.` });
    }
  });

  return router;
}

module.exports = createKycRouter;
