const { expect } = require("chai");
const express = require("express");
const request = require("supertest");
const sinon = require("sinon");
const { ethers } = require("ethers");

const createKycRouter = require("../../middleware/src/routes/kycRoutes");
const { buildChallenge } = require("../../middleware/src/services/challengeService");
const { resetStore, users, auditLog, challenges } = require("../../middleware/src/state/store");

function buildTestApp({ identityClient, providerAdapter, config }) {
  const app = express();
  app.use(express.json());
  app.use("/api/kyc", createKycRouter({ identityClient, providerAdapter, config }));
  return app;
}

describe("Middleware: kycRoutes", function () {
  let identityClient;
  let providerAdapter;
  let app;
  let config;

  beforeEach(function () {
    resetStore();

    identityClient = {
      signer: { address: "0x0000000000000000000000000000000000000009" },
      contract: { target: "0x0000000000000000000000000000000000000010" },
      whitelist: sinon.stub().resolves({ txHash: "0xwhitelist", blockNumber: 11, role: "TRADER" }),
      updateAttestation: sinon.stub().resolves({ txHash: "0xattestation", blockNumber: 12 }),
      revoke: sinon.stub().resolves({ txHash: "0xrevoke", blockNumber: 13 }),
      prefersEasyReverification: sinon.stub().resolves(true),
      isWhitelisted: sinon.stub().resolves(true),
    };

    providerAdapter = {
      name: "simulated-eidas",
      verifyIdentity: sinon.stub().resolves({ approved: true, role: "TRADER", provider: "simulated-eidas", evidenceId: "SIM-1" }),
    };

    config = {
      challengeTtlSeconds: 120,
      attestationDays: 30,
    };

    app = buildTestApp({ identityClient, providerAdapter, config });
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns health info", async function () {
    const response = await request(app).get("/api/kyc/health");
    expect(response.status).to.equal(200);
    expect(response.body.ok).to.equal(true);
    expect(response.body.provider).to.equal("simulated-eidas");
  });

  it("rejects invalid wallet on request", async function () {
    const response = await request(app).post("/api/kyc/request").send({ walletAddress: "not-an-address" });
    expect(response.status).to.equal(400);
  });

  it("rejects request when wallet is missing", async function () {
    const response = await request(app).post("/api/kyc/request").send({ requestedRole: "TRADER" });
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Valid walletAddress is required");
  });

  it("creates challenge on request", async function () {
    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    expect(response.status).to.equal(200);
    expect(response.body.challengeMessage).to.include("TSS KYC wallet challenge");
    expect(response.body.walletAddress).to.equal(wallet.address);
  });

  it("invalidates old challenge signature after a new request for same wallet", async function () {
    const wallet = ethers.Wallet.createRandom();

    const firstRequest = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-old" } });
    expect(firstRequest.status).to.equal(200);

    const firstSignature = await wallet.signMessage(firstRequest.body.challengeMessage);

    const secondRequest = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-new" } });
    expect(secondRequest.status).to.equal(200);

    const staleVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature: firstSignature });

    expect(staleVerify.status).to.equal(400);
    expect(staleVerify.body.error).to.equal("Wallet signature mismatch");
  });

  it("rejects verify without signature", async function () {
    const wallet = ethers.Wallet.createRandom();
    const response = await request(app).post("/api/kyc/verify").send({ walletAddress: wallet.address });
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("signature is required");
  });

  it("rejects verify with invalid wallet", async function () {
    const response = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: "not-an-address", signature: "0xabc" });

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Valid walletAddress is required");
  });

  it("rejects verify when no challenge exists", async function () {
    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature: "0xdeadbeef" });

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("No active challenge for wallet");
  });

  it("rejects verify when challenge signature does not match wallet", async function () {
    const wallet = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();

    await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const message = buildChallenge(wallet.address, 120).message;
    const badSignature = await attacker.signMessage(message);

    const response = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature: badSignature });

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Wallet signature mismatch");
  });

  it("rejects verify when challenge is reused", async function () {
    const wallet = ethers.Wallet.createRandom();

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);

    const firstVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });
    expect(firstVerify.status).to.equal(200);

    const secondVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(secondVerify.status).to.equal(400);
    expect(secondVerify.body.error).to.equal("Challenge already used");
  });

  it("rejects verify when challenge expires", async function () {
    const wallet = ethers.Wallet.createRandom();

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const key = wallet.address.toLowerCase();
    const challenge = challenges.get(key);
    challenge.expiresAt = Date.now() - 1;
    challenges.set(key, challenge);

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("Challenge expired");
  });

  it("approves verify path in easy mode and updates attestation", async function () {
    const wallet = ethers.Wallet.createRandom();

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature, attestationDays: 10 });

    expect(verifyRes.status).to.equal(200);
    expect(verifyRes.body.approved).to.equal(true);
    expect(identityClient.whitelist.calledOnce).to.equal(true);
    expect(identityClient.updateAttestation.calledOnce).to.equal(true);
    expect(users.get(wallet.address.toLowerCase()).kycStatus).to.equal("approved");
  });

  it("handles strict mode by skipping on-chain attestation refresh", async function () {
    identityClient.prefersEasyReverification.resolves(false);
    const wallet = ethers.Wallet.createRandom();

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature, attestationDays: 5 });

    expect(verifyRes.status).to.equal(200);
    expect(identityClient.whitelist.calledOnce).to.equal(true);
    expect(identityClient.updateAttestation.called).to.equal(false);
    expect(verifyRes.body.offchainNextReviewAt).to.be.a("string");
  });

  it("rejects verification when simulated provider rejects", async function () {
    providerAdapter.verifyIdentity.resolves({ approved: false, reason: "Sanctions or PEP check failed" });

    const wallet = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1", isPep: true } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(verifyRes.status).to.equal(403);
    expect(identityClient.whitelist.called).to.equal(false);
  });

  it("returns 400 when chain whitelist call fails", async function () {
    identityClient.whitelist.rejects(new Error("Identity: caller is not an operator"));

    const wallet = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.include("operator");
  });

  it("returns 400 when provider returns invalid role", async function () {
    identityClient.whitelist.callsFake(async (walletAddress, role) => {
      if (!["TRADER", "ISSUER", "OPERATOR", "REGULATOR"].includes(role)) {
        throw new Error("Invalid role 'INVALID_ROLE'. Use one of: TRADER, ISSUER, OPERATOR, REGULATOR");
      }
      return { txHash: "0xwhitelist", blockNumber: 11, role };
    });

    providerAdapter.verifyIdentity.resolves({
      approved: true,
      role: "INVALID_ROLE",
      provider: "simulated-eidas",
      evidenceId: "SIM-BAD",
    });

    const wallet = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.include("Invalid role");
  });

  it("returns 400 when provider throws during verify", async function () {
    providerAdapter.verifyIdentity.rejects(new Error("Provider offline"));

    const wallet = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("Provider offline");
  });

  it("returns 400 when attestation update fails in easy mode", async function () {
    identityClient.updateAttestation.rejects(new Error("attestation update failed"));

    const wallet = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("attestation update failed");
  });

  it("rejects verify when attestationDays is invalid", async function () {
    const wallet = ethers.Wallet.createRandom();

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "id-1" } });

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature, attestationDays: 0 });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("attestationDays must be an integer between 1 and 3650");
  });

  it("reverify easy mode updates attestation only", async function () {
    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, attestationDays: 7 });

    expect(response.status).to.equal(200);
    expect(response.body.mode).to.equal("easy");
    expect(identityClient.updateAttestation.calledOnce).to.equal(true);
    expect(identityClient.whitelist.called).to.equal(false);
  });

  it("rejects reverify with invalid wallet", async function () {
    const response = await request(app).post("/api/kyc/reverify").send({ walletAddress: "bad-address" });
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Valid walletAddress is required");
  });

  it("reverify strict mode re-runs KYC and whitelists", async function () {
    identityClient.prefersEasyReverification.resolves(false);

    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, requestedRole: "ISSUER", identityData: { identifier: "renew-1" } });

    expect(response.status).to.equal(200);
    expect(response.body.mode).to.equal("strict");
    expect(identityClient.whitelist.calledOnce).to.equal(true);
  });

  it("reverify strict mode uses existing role when requestedRole is missing", async function () {
    identityClient.prefersEasyReverification.resolves(false);
    const wallet = ethers.Wallet.createRandom();
    users.set(wallet.address.toLowerCase(), { walletAddress: wallet.address, role: "ISSUER", kycStatus: "approved" });

    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, identityData: { identifier: "renew-existing-role" } });

    expect(response.status).to.equal(200);
    expect(providerAdapter.verifyIdentity.calledOnce).to.equal(true);
    expect(providerAdapter.verifyIdentity.firstCall.args[0].requestedRole).to.equal("ISSUER");
  });

  it("reverify strict mode defaults to TRADER when no existing role and no requestedRole", async function () {
    identityClient.prefersEasyReverification.resolves(false);
    const wallet = ethers.Wallet.createRandom();

    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, identityData: { identifier: "renew-default-role" } });

    expect(response.status).to.equal(200);
    expect(providerAdapter.verifyIdentity.calledOnce).to.equal(true);
    expect(providerAdapter.verifyIdentity.firstCall.args[0].requestedRole).to.equal("TRADER");
  });

  it("returns 400 when reverify easy mode attestation update fails", async function () {
    identityClient.updateAttestation.rejects(new Error("easy reverify failed"));

    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, attestationDays: 7 });

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("easy reverify failed");
  });

  it("rejects reverify when attestationDays is invalid", async function () {
    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, attestationDays: "NaN" });

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("attestationDays must be an integer between 1 and 3650");
  });

  it("reverify strict mode rejects if provider rejects", async function () {
    identityClient.prefersEasyReverification.resolves(false);
    providerAdapter.verifyIdentity.resolves({ approved: false, reason: "verification failed" });

    const wallet = ethers.Wallet.createRandom();
    const response = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: wallet.address, requestedRole: "TRADER", identityData: { identifier: "renew-1" } });

    expect(response.status).to.equal(403);
    expect(identityClient.whitelist.called).to.equal(false);
  });

  it("revoke endpoint revokes on-chain and updates local state", async function () {
    const wallet = ethers.Wallet.createRandom();

    const response = await request(app)
      .post("/api/kyc/revoke")
      .send({ walletAddress: wallet.address, reason: "manual_revoke" });

    expect(response.status).to.equal(200);
    expect(response.body.revoked).to.equal(true);
    expect(identityClient.revoke.calledOnce).to.equal(true);
    expect(users.get(wallet.address.toLowerCase()).kycStatus).to.equal("revoked");
  });

  it("returns 400 when revoke chain call fails", async function () {
    identityClient.revoke.rejects(new Error("revoke failed"));
    const wallet = ethers.Wallet.createRandom();

    const response = await request(app)
      .post("/api/kyc/revoke")
      .send({ walletAddress: wallet.address, reason: "manual_revoke" });

    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("revoke failed");
  });

  it("rejects revoke with invalid wallet", async function () {
    const response = await request(app).post("/api/kyc/revoke").send({ walletAddress: "bad-address" });
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Valid walletAddress is required");
  });

  it("users endpoint returns local and on-chain state", async function () {
    const wallet = ethers.Wallet.createRandom();
    users.set(wallet.address.toLowerCase(), { walletAddress: wallet.address, kycStatus: "approved" });

    const response = await request(app).get(`/api/kyc/users/${wallet.address}`);

    expect(response.status).to.equal(200);
    expect(response.body.walletAddress).to.equal(wallet.address);
    expect(response.body.local.kycStatus).to.equal("approved");
    expect(response.body.onChainWhitelisted).to.equal(true);
  });

  it("users endpoint returns 500 if chain read fails", async function () {
    identityClient.isWhitelisted.rejects(new Error("rpc unavailable"));
    const wallet = ethers.Wallet.createRandom();

    const response = await request(app).get(`/api/kyc/users/${wallet.address}`);
    expect(response.status).to.equal(500);
    expect(response.body.error).to.equal("rpc unavailable");
  });

  it("users endpoint rejects invalid wallet", async function () {
    const response = await request(app).get("/api/kyc/users/not-an-address");
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Invalid wallet address");
  });

  it("audit endpoint returns entries newest-first and supports pagination", async function () {
    auditLog.push({ id: 1, timestamp: new Date().toISOString(), action: "a" });
    auditLog.push({ id: 2, timestamp: new Date().toISOString(), action: "b" });

    // Entries are returned in reverse-chronological order (newest first),
    // so offset=0 -> "b" (newest) and offset=1 -> "a" (second-newest).
    const newest = await request(app).get("/api/kyc/audit?limit=1&offset=0");
    expect(newest.status).to.equal(200);
    expect(newest.body.entries).to.have.length(1);
    expect(newest.body.entries[0].action).to.equal("b");

    const response = await request(app).get("/api/kyc/audit?limit=1&offset=1");
    expect(response.status).to.equal(200);
    expect(response.body.entries).to.have.length(1);
    expect(response.body.entries[0].action).to.equal("a");
  });

  it("audit endpoint caps limit to 200 entries", async function () {
    for (let i = 0; i < 250; i++) {
      auditLog.push({ id: i + 1, timestamp: new Date().toISOString(), action: `evt-${i}` });
    }

    const response = await request(app).get("/api/kyc/audit?limit=1000");

    expect(response.status).to.equal(200);
    expect(response.body.entries).to.have.length(200);
  });

  it("audit endpoint falls back to defaults for invalid pagination values", async function () {
    auditLog.push({ id: 1, timestamp: new Date().toISOString(), action: "evt-1" });
    auditLog.push({ id: 2, timestamp: new Date().toISOString(), action: "evt-2" });

    const response = await request(app).get("/api/kyc/audit?limit=abc&offset=-10");
    expect(response.status).to.equal(200);
    expect(response.body.entries).to.have.length(2);
  });
});
