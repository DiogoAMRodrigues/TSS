/**
 * eIDAS / AMA SAML routes.
 *
 * Flow:
 *   1. Client: POST /api/kyc/request → gets challenge (existing route)
 *   2. Client: signs challenge with wallet
 *   3. Client browser → GET /api/kyc/eidas/start?walletAddress=&signature=&requestedRole=&attestationDays=
 *      → middleware verifies signature, builds signed AuthnRequest with
 *        AMA's <fa:RequestedAttributes>, returns auto-submit HTML form
 *      → browser POSTs SAMLRequest+RelayState to AMA preprod
 *   4. User authenticates with CC / CMD on AMA
 *   5. AMA → POST /api/kyc/eidas/callback (SAMLResponse + RelayState)
 *      → middleware validates IdP signature + audience + conditions,
 *        extracts NIC etc., calls providerAdapter.verifyIdentity,
 *        whitelists wallet on chain, renders success page.
 *
 * RelayState carries the kycCase key (wallet address). Re-using the
 * existing kycCases store: /eidas/start expects a pending case from
 * /api/kyc/request.
 */

const express = require("express");
const { ethers } = require("ethers");
const { verifySignedChallenge } = require("../services/challengeService");
const { kycCases, users, toKey, writeAudit, persistNow } = require("../state/store");
const { ROLES } = require("../security/auth");

function toUnixAfterDays(days) {
  return Math.floor(Date.now() / 1000) + Math.max(1, Number(days)) * 24 * 60 * 60;
}

function parseAttestationDays(days, fallback) {
  const raw = days === undefined ? fallback : days;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error("attestationDays must be an integer between 1 and 3650");
  }
  return value;
}

function htmlPostForm({ actionUrl, samlRequestB64, relayState }) {
  const safe = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Redirecting to Autenticação.gov…</title></head>
<body onload="document.forms[0].submit()">
<noscript><p>JavaScript is disabled. Click the button to continue.</p></noscript>
<form method="POST" action="${safe(actionUrl)}">
  <input type="hidden" name="SAMLRequest" value="${safe(samlRequestB64)}"/>
  <input type="hidden" name="RelayState" value="${safe(relayState)}"/>
  <noscript><button type="submit">Continue to Autenticação.gov</button></noscript>
</form>
</body></html>`;
}

function htmlSuccess({ walletAddress, role, txHash }) {
  const safe = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>KYC approved</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;}code{background:#f4f4f4;padding:2px 6px;border-radius:3px;}</style>
</head><body>
<h2>✓ KYC approved via Autenticação.gov</h2>
<p>Wallet <code>${safe(walletAddress)}</code> has been whitelisted as <strong>${safe(role)}</strong>.</p>
<p>On-chain tx: <code>${safe(txHash)}</code></p>
<p>You can close this window.</p>
</body></html>`;
}

function htmlError(reason, status) {
  const safe = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>KYC failed</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;}pre{background:#fff0f0;padding:12px;border-radius:6px;white-space:pre-wrap;}</style>
</head><body>
<h2>✗ KYC failed (HTTP ${status})</h2>
<pre>${safe(reason)}</pre>
</body></html>`;
}

function createEidasRouter({ identityClient, providerAdapter, config, auth, rateLimiters }) {
  const router = express.Router();
  const noAuth = (_req, _res, next) => next();
  const noLimit = (_req, _res, next) => next();
  const requireAuth = auth?.requireAuth || (() => noAuth);
  const globalLimiter = rateLimiters?.globalLimiter || noLimit;
  const verifyLimiter = rateLimiters?.verifyLimiter || noLimit;

  // AMA ACS callback must accept x-www-form-urlencoded (SAML POST binding).
  // app.js uses express.json() globally — add urlencoded only on this router.
  router.use(express.urlencoded({ extended: false, limit: "1mb" }));
  router.use(globalLimiter);

  // -------- /eidas/start --------------------------------------------------
  // Auth on the entry point (wallet-signed challenge), but not on /callback —
  // AMA's POST won't carry our API key.
  router.get(
    "/start",
    requireAuth([ROLES.CLIENT, ROLES.OPERATOR]),
    verifyLimiter,
    async (req, res) => {
      try {
        const {
          walletAddress,
          signature,
          requestedRole,
          attestationDays = config.attestationDays,
        } = req.query || {};

        if (!walletAddress || !ethers.isAddress(walletAddress)) {
          return res.status(400).type("html").send(htmlError("Valid walletAddress is required", 400));
        }
        if (!signature) {
          return res.status(400).type("html").send(htmlError("signature query param is required", 400));
        }

        // Wallet ownership proof — same as POST /api/kyc/verify
        verifySignedChallenge(walletAddress, signature);

        const key = toKey(walletAddress);
        const caseData = kycCases.get(key);
        if (!caseData) {
          return res.status(400).type("html").send(htmlError("No pending KYC request — call POST /api/kyc/request first", 400));
        }

        const parsedAttestationDays = parseAttestationDays(attestationDays, config.attestationDays);

        // Stash params on the case so /callback can finalize without auth
        caseData.eidas = {
          requestedRole: requestedRole || caseData.requestedRole,
          attestationDays: parsedAttestationDays,
          startedAt: new Date().toISOString(),
        };
        caseData.status = "pending_eidas";
        kycCases.set(key, caseData);
        writeAudit({ action: "eidas_start", walletAddress });
        persistNow();

        const { base64, relayState } = providerAdapter.buildAuthnRequest({
          relayState: walletAddress,
        });

        return res
          .status(200)
          .type("html")
          .send(
            htmlPostForm({
              actionUrl: providerAdapter.config.idpEntryPoint,
              samlRequestB64: base64,
              relayState,
            })
          );
      } catch (error) {
        return res.status(400).type("html").send(htmlError(error.message, 400));
      }
    }
  );

  // -------- /eidas/callback (AMA → us, no auth) ---------------------------
  router.post("/callback", async (req, res) => {
    try {
      const samlResponseB64 = req.body?.SAMLResponse;
      const relayState = req.body?.RelayState;
      if (!samlResponseB64) {
        return res.status(400).type("html").send(htmlError("Missing SAMLResponse", 400));
      }
      if (!relayState || !ethers.isAddress(relayState)) {
        return res.status(400).type("html").send(htmlError("Missing/invalid RelayState (expected wallet address)", 400));
      }
      const walletAddress = relayState;
      const key = toKey(walletAddress);
      const caseData = kycCases.get(key);
      if (!caseData || caseData.status !== "pending_eidas") {
        return res.status(400).type("html").send(htmlError(`No pending eIDAS case for ${walletAddress}`, 400));
      }

      // 1. Validate signature + conditions, extract attributes
      const validated = providerAdapter.validateResponse(samlResponseB64);
      const samlAttributes = providerAdapter.extractIdentity(validated);

      // 2. Run provider-level approval (sanctions/PEP placeholder)
      const result = await providerAdapter.verifyIdentity({
        walletAddress,
        requestedRole: caseData.eidas.requestedRole,
        identityData: {
          samlAttributes,
          assertionId: validated.assertionId,
          ...caseData.identityData, // any sanctions flags from /request
        },
      });

      if (!result.approved) {
        caseData.status = "rejected";
        caseData.rejectionReason = result.reason;
        kycCases.set(key, caseData);
        writeAudit({ action: "eidas_rejected", walletAddress, reason: result.reason });
        persistNow();
        return res.status(403).type("html").send(htmlError(result.reason, 403));
      }

      // 3. Whitelist on chain + optional attestation (mirror kycRoutes /verify)
      const role = result.role || caseData.eidas.requestedRole;
      const whitelistTx = await identityClient.whitelist(walletAddress, role);

      let attestationTx = null;
      let expiryUnixSeconds = null;
      const easy = await identityClient.prefersEasyReverification(walletAddress);
      if (easy) {
        expiryUnixSeconds = toUnixAfterDays(caseData.eidas.attestationDays);
        attestationTx = await identityClient.updateAttestation(walletAddress, expiryUnixSeconds);
      }

      const userRecord = {
        walletAddress,
        role: whitelistTx.role,
        provider: result.provider,
        evidenceId: result.evidenceId,
        easyReverification: easy,
        kycStatus: "approved",
        nic: samlAttributes.nic,
        nomeCompleto: samlAttributes.nomeCompleto,
        updatedAt: new Date().toISOString(),
        offchainNextReviewAt: easy
          ? null
          : new Date(Date.now() + caseData.eidas.attestationDays * 24 * 60 * 60 * 1000).toISOString(),
      };
      users.set(key, userRecord);
      caseData.status = "approved";
      caseData.completedAt = new Date().toISOString();
      kycCases.set(key, caseData);

      writeAudit({
        action: "eidas_approved",
        walletAddress,
        role: whitelistTx.role,
        whitelistTxHash: whitelistTx.txHash,
        attestationTxHash: attestationTx?.txHash || null,
        evidenceId: result.evidenceId,
      });
      persistNow();

      return res
        .status(200)
        .type("html")
        .send(htmlSuccess({ walletAddress, role: whitelistTx.role, txHash: whitelistTx.txHash }));
    } catch (error) {
      return res.status(400).type("html").send(htmlError(error.message, 400));
    }
  });

  return router;
}

module.exports = createEidasRouter;
