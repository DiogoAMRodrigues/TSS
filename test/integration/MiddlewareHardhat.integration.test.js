const { expect } = require("chai");
const express = require("express");
const request = require("supertest");
const { ethers } = require("hardhat");

const IdentityClient = require("../../middleware/src/services/identityClient");
const createKycRouter = require("../../middleware/src/routes/kycRoutes");
const SimulatedEidasProvider = require("../../middleware/src/providers/simulatedEidasProvider");
const { resetStore } = require("../../middleware/src/state/store");

function buildApp(identityClient, providerAdapter = new SimulatedEidasProvider()) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/kyc",
    createKycRouter({
      identityClient,
      providerAdapter,
      config: {
        challengeTtlSeconds: 180,
        attestationDays: 7,
      },
    })
  );
  return app;
}

describe("Integration: Middleware on Hardhat chain", function () {
  let identity;
  let operator;
  let userA;
  let userB;
  let app;
  let identityClient;

  beforeEach(async function () {
    resetStore();

    [operator, userA, userB] = await ethers.getSigners();
    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    identityClient = new IdentityClient({
      provider: ethers.provider,
      signer: operator,
      contract: identity.connect(operator),
    });

    app = buildApp(identityClient);
  });

  async function requestAndVerify(walletSigner, requestedRole = "TRADER", identityData = { identifier: "hardhat-user" }) {
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({
        walletAddress: walletSigner.address,
        requestedRole,
        identityData,
      });

    expect(requestRes.status).to.equal(200);
    const signature = await walletSigner.signMessage(requestRes.body.challengeMessage);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: walletSigner.address, signature, attestationDays: 3 });

    return { requestRes, verifyRes, signature };
  }

  it("executes full KYC verification and updates on-chain whitelist", async function () {
    const { verifyRes } = await requestAndVerify(userA, "TRADER", { identifier: "hardhat-user-1" });

    expect(verifyRes.status).to.equal(200);
    expect(verifyRes.body.approved).to.equal(true);
    expect(verifyRes.body.whitelistTx.txHash).to.match(/^0x/);
    expect(verifyRes.body.attestationTx.txHash).to.match(/^0x/);

    const onChainWhitelisted = await identity.isWhitelisted(userA.address);
    expect(onChainWhitelisted).to.equal(true);

    const roleBytes = await identity.getRole(userA.address);
    expect(roleBytes).to.equal(ethers.keccak256(ethers.toUtf8Bytes("TRADER")));

    const expired = await identity.isExpired(userA.address);
    expect(expired).to.equal(false);
  });

  it("supports strict mode by skipping on-chain attestation refresh", async function () {
    await identity.connect(userB).setReverificationPreference(false);
    const { verifyRes } = await requestAndVerify(userB, "ISSUER", { identifier: "hardhat-user-2" });

    expect(verifyRes.status).to.equal(200);
    expect(verifyRes.body.attestationTx).to.equal(null);
    expect(verifyRes.body.offchainNextReviewAt).to.be.a("string");

    const onChainWhitelisted = await identity.isWhitelisted(userB.address);
    expect(onChainWhitelisted).to.equal(true);

    const roleBytes = await identity.getRole(userB.address);
    expect(roleBytes).to.equal(ethers.keccak256(ethers.toUtf8Bytes("ISSUER")));
  });

  it("rejects provider-denied identity and keeps user off-chain", async function () {
    const rejectingProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        return { approved: false, reason: "Sanctions or PEP check failed" };
      },
    };

    app = buildApp(identityClient, rejectingProvider);

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "pep-user", isPep: true } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app).post("/api/kyc/verify").send({ walletAddress: userA.address, signature });

    expect(verifyRes.status).to.equal(403);
    expect(verifyRes.body.approved).to.equal(false);

    const onChainWhitelisted = await identity.isWhitelisted(userA.address);
    expect(onChainWhitelisted).to.equal(false);
  });

  it("rejects invalid role returned by provider", async function () {
    const badRoleProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        return {
          approved: true,
          role: "NOT_A_REAL_ROLE",
          provider: "simulated-eidas",
          evidenceId: "SIM-BAD-ROLE",
        };
      },
    };

    app = buildApp(identityClient, badRoleProvider);

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "bad-role-user" } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app).post("/api/kyc/verify").send({ walletAddress: userA.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.include("Invalid role");
    expect(await identity.isWhitelisted(userA.address)).to.equal(false);
  });

  it("blocks replay of a previously used signed challenge", async function () {
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "replay-user" } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);

    const firstVerify = await request(app).post("/api/kyc/verify").send({ walletAddress: userA.address, signature });
    expect(firstVerify.status).to.equal(200);

    const secondVerify = await request(app).post("/api/kyc/verify").send({ walletAddress: userA.address, signature });
    expect(secondVerify.status).to.equal(400);
    expect(secondVerify.body.error).to.equal("Challenge already used");
  });

  it("fails verification when middleware signer is not operator", async function () {
    const nonOperatorClient = new IdentityClient({
      provider: ethers.provider,
      signer: userB,
      contract: identity.connect(userB),
    });
    app = buildApp(nonOperatorClient);

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "non-operator-case" } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app).post("/api/kyc/verify").send({ walletAddress: userA.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.include("not an operator");
    expect(await identity.isWhitelisted(userA.address)).to.equal(false);
  });

  it("revokes a previously whitelisted user on-chain", async function () {
    const { verifyRes } = await requestAndVerify(userA, "TRADER", { identifier: "revoke-user" });
    expect(verifyRes.status).to.equal(200);
    expect(await identity.isWhitelisted(userA.address)).to.equal(true);

    const revokeRes = await request(app).post("/api/kyc/revoke").send({ walletAddress: userA.address, reason: "manual_test_revoke" });
    expect(revokeRes.status).to.equal(200);
    expect(revokeRes.body.revoked).to.equal(true);

    expect(await identity.isWhitelisted(userA.address)).to.equal(false);
    expect(await identity.getRole(userA.address)).to.equal(ethers.ZeroHash);
  });

  it("serves users endpoint with on-chain and local state after verify", async function () {
    const { verifyRes } = await requestAndVerify(userA, "REGULATOR", { identifier: "users-endpoint-user" });
    expect(verifyRes.status).to.equal(200);

    const usersRes = await request(app).get(`/api/kyc/users/${userA.address}`);
    expect(usersRes.status).to.equal(200);
    expect(usersRes.body.walletAddress).to.equal(userA.address);
    expect(usersRes.body.onChainWhitelisted).to.equal(true);
    expect(usersRes.body.local.role).to.equal("REGULATOR");
  });

  it("records expected audit actions across request and verify", async function () {
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "audit-user" } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app).post("/api/kyc/verify").send({ walletAddress: userA.address, signature });
    expect(verifyRes.status).to.equal(200);

    const auditRes = await request(app).get("/api/kyc/audit?limit=20&offset=0");
    expect(auditRes.status).to.equal(200);

    const actions = auditRes.body.entries.map((entry) => entry.action);
    expect(actions).to.include("kyc_request_created");
    expect(actions).to.include("kyc_approved");
  });

  it("reverify easy path refreshes attestation for whitelisted user", async function () {
    const { verifyRes } = await requestAndVerify(userA, "TRADER", { identifier: "easy-reverify-user" });
    expect(verifyRes.status).to.equal(200);

    const reverifyRes = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: userA.address, attestationDays: 9 });

    expect(reverifyRes.status).to.equal(200);
    expect(reverifyRes.body.mode).to.equal("easy");
    expect(reverifyRes.body.attestationTx.txHash).to.match(/^0x/);
  });

  it("reverify strict path re-runs verification and re-whitelists", async function () {
    await identity.connect(userB).setReverificationPreference(false);
    const { verifyRes } = await requestAndVerify(userB, "ISSUER", { identifier: "strict-reverify-initial" });
    expect(verifyRes.status).to.equal(200);

    const reverifyRes = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: userB.address, identityData: { identifier: "strict-reverify-renew" } });

    expect(reverifyRes.status).to.equal(200);
    expect(reverifyRes.body.mode).to.equal("strict");
    expect(reverifyRes.body.whitelistTx.txHash).to.match(/^0x/);
    expect(await identity.isWhitelisted(userB.address)).to.equal(true);
  });

  it("returns 400 for malformed signature payload", async function () {
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "malformed-sig" } });
    expect(requestRes.status).to.equal(200);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: userA.address, signature: "not-a-signature" });

    expect(verifyRes.status).to.equal(400);
  });

  it("invalidates old signature after issuing a new challenge", async function () {
    const firstReq = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "challenge-1" } });
    expect(firstReq.status).to.equal(200);
    const firstSig = await userA.signMessage(firstReq.body.challengeMessage);

    const secondReq = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "challenge-2" } });
    expect(secondReq.status).to.equal(200);

    const staleVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: userA.address, signature: firstSig });
    expect(staleVerify.status).to.equal(400);
    expect(staleVerify.body.error).to.equal("Wallet signature mismatch");
  });

  it("returns 400 on strict reverify when provider rejects renewal", async function () {
    await identity.connect(userB).setReverificationPreference(false);
    const { verifyRes } = await requestAndVerify(userB, "ISSUER", { identifier: "strict-reverify-reject-initial" });
    expect(verifyRes.status).to.equal(200);

    const rejectingProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        return { approved: false, reason: "Sanctions or PEP check failed" };
      },
    };

    app = buildApp(identityClient, rejectingProvider);

    const reverifyRes = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: userB.address, identityData: { identifier: "strict-reverify-reject-renew" } });

    expect(reverifyRes.status).to.equal(403);
    expect(reverifyRes.body.approved).to.equal(false);
    expect(await identity.isWhitelisted(userB.address)).to.equal(true);
  });

  it("returns 400 when provider throws in verify flow", async function () {
    const failingProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        throw new Error("Provider offline");
      },
    };

    app = buildApp(identityClient, failingProvider);

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "provider-throw" } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: userA.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("Provider offline");
    expect(await identity.isWhitelisted(userA.address)).to.equal(false);
  });

  it("rejects invalid wallet on users endpoint", async function () {
    const response = await request(app).get("/api/kyc/users/not-an-address");
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Invalid wallet address");
  });

  it("rejects verify when attestationDays is invalid", async function () {
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "invalid-att-days" } });
    expect(requestRes.status).to.equal(200);

    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: userA.address, signature, attestationDays: 5001 });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("attestationDays must be an integer between 1 and 3650");
  });

  it("sanitizes invalid audit pagination values", async function () {
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: userA.address, requestedRole: "TRADER", identityData: { identifier: "audit-pagination" } });
    expect(requestRes.status).to.equal(200);
    const signature = await userA.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: userA.address, signature });
    expect(verifyRes.status).to.equal(200);

    const auditRes = await request(app).get("/api/kyc/audit?limit=NaN&offset=-1");
    expect(auditRes.status).to.equal(200);
    expect(auditRes.body.entries.length).to.be.greaterThan(0);
  });
});
