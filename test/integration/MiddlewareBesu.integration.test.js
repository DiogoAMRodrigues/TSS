const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { expect } = require("chai");
const { ethers } = require("ethers");

const IdentityClient = require("../../middleware/src/services/identityClient");
const createKycRouter = require("../../middleware/src/routes/kycRoutes");
const SimulatedEidasProvider = require("../../middleware/src/providers/simulatedEidasProvider");
const { resetStore } = require("../../middleware/src/state/store");

function loadBesuIdentityAddress() {
  const deploymentPath = path.resolve(process.cwd(), "deployments", "besu.json");
  if (!fs.existsSync(deploymentPath)) {
    return null;
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  return deployment?.contracts?.Identity || null;
}

function loadIdentityArtifact() {
  const artifactPath = path.resolve(
    process.cwd(),
    "artifacts",
    "contracts",
    "identity",
    "Identity.sol",
    "Identity.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

async function deployIdentityIfNeeded({ operatorWallet, configuredIdentityAddress }) {
  if (configuredIdentityAddress) {
    return configuredIdentityAddress;
  }

  const { abi, bytecode } = loadIdentityArtifact();
  const factory = new ethers.ContractFactory(abi, bytecode, operatorWallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return await contract.getAddress();
}

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

describe("Integration: Middleware on Besu network", function () {
  this.timeout(180000);

  let app;
  let identityClient;
  let nonOperatorWallet;
  let rpcUrl;
  let skipReason = null;

  function enforceOrSkip(ctx, message) {
    if (process.env.BESU_TEST_REQUIRE_READY === "1") {
      throw new Error(message);
    }
    skipReason = message;
    ctx.skip();
  }

  before(async function () {
    resetStore();

    rpcUrl = process.env.BESU_RPC_URL || process.env.RPC_URL || "http://localhost:8545";
    const operatorPrivateKey =
      process.env.BESU_OPERATOR_PRIVATE_KEY ||
      process.env.OPERATOR_PRIVATE_KEY ||
      "0x1ca60577f0b6dbf9ebddeb330615c25824f2e458eed044b0abc3ac954eb1f3db";
    const nonOperatorPrivateKey =
      process.env.BESU_NON_OPERATOR_PRIVATE_KEY ||
      "0xae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f";

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    try {
      await provider.getBlockNumber();
    } catch (error) {
      enforceOrSkip(this, `Besu test skipped: RPC ${rpcUrl} not reachable.`);
      return;
    }

    const operatorWallet = new ethers.Wallet(operatorPrivateKey, provider);
    nonOperatorWallet = new ethers.Wallet(nonOperatorPrivateKey, provider);

    const configuredIdentityAddress =
      process.env.BESU_IDENTITY_ADDRESS ||
      process.env.IDENTITY_ADDRESS ||
      loadBesuIdentityAddress();

    const identityAddress = await deployIdentityIfNeeded({
      operatorWallet,
      configuredIdentityAddress,
    });

    if (!identityAddress) {
      enforceOrSkip(this, "Besu test skipped: could not resolve or deploy Identity contract.");
      return;
    }

    identityClient = new IdentityClient({
      rpcUrl,
      privateKey: operatorPrivateKey,
      identityAddress,
    });

    app = buildApp(identityClient);
  });

  after(function () {
    if (skipReason) {
      console.log(skipReason);
    }
  });

  async function requestAndVerify(
    appInstance,
    wallet,
    role = "TRADER",
    identityData = { identifier: `besu-${Date.now()}` }
  ) {
    const requestRes = await request(appInstance)
      .post("/api/kyc/request")
      .send({
        walletAddress: wallet.address,
        requestedRole: role,
        identityData,
      });

    expect(requestRes.status).to.equal(200);

    const signature = await wallet.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(appInstance)
      .post("/api/kyc/verify")
      .send({ walletAddress: wallet.address, signature, attestationDays: 7 });

    return { requestRes, verifyRes, signature };
  }

  it("returns middleware health metadata", async function () {
    const response = await request(app).get("/api/kyc/health");
    expect(response.status).to.equal(200);
    expect(response.body.ok).to.equal(true);
    expect(response.body.provider).to.equal("simulated-eidas");
  });

  it("processes end-to-end verify flow against live Besu contract", async function () {
    const user = ethers.Wallet.createRandom();
    const { verifyRes } = await requestAndVerify(app, user, "TRADER", {
      identifier: `besu-${Date.now()}`,
    });

    expect(verifyRes.status).to.equal(200);
    expect(verifyRes.body.approved).to.equal(true);
    expect(verifyRes.body.whitelistTx.txHash).to.match(/^0x/);

    const onChainWhitelisted = await identityClient.isWhitelisted(user.address);
    expect(onChainWhitelisted).to.equal(true);
  });

  it("rejects replaying a used challenge signature", async function () {
    const user = ethers.Wallet.createRandom();

    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({
        walletAddress: user.address,
        requestedRole: "TRADER",
        identityData: { identifier: `replay-${Date.now()}` },
      });

    expect(requestRes.status).to.equal(200);

    const signature = await user.signMessage(requestRes.body.challengeMessage);
    const firstVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });
    expect(firstVerify.status).to.equal(200);

    const secondVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });
    expect(secondVerify.status).to.equal(400);
    expect(secondVerify.body.error).to.equal("Challenge already used");
  });

  it("keeps user off-chain when provider rejects", async function () {
    const rejectingProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        return { approved: false, reason: "Sanctions or PEP check failed" };
      },
    };

    const appWithReject = buildApp(identityClient, rejectingProvider);

    const user = ethers.Wallet.createRandom();
    const requestRes = await request(appWithReject)
      .post("/api/kyc/request")
      .send({
        walletAddress: user.address,
        requestedRole: "TRADER",
        identityData: { identifier: `pep-${Date.now()}`, isPep: true },
      });

    const signature = await user.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(appWithReject)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });
    expect(verifyRes.status).to.equal(403);

    const onChainWhitelisted = await identityClient.isWhitelisted(user.address);
    expect(onChainWhitelisted).to.equal(false);
  });

  it("fails when provider returns invalid role", async function () {
    const badRoleProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        return {
          approved: true,
          role: "BAD_ROLE",
          provider: "simulated-eidas",
          evidenceId: `SIM-BAD-${Date.now()}`,
        };
      },
    };

    const appWithBadRole = buildApp(identityClient, badRoleProvider);

    const user = ethers.Wallet.createRandom();
    const requestRes = await request(appWithBadRole)
      .post("/api/kyc/request")
      .send({
        walletAddress: user.address,
        requestedRole: "TRADER",
        identityData: { identifier: `invalid-role-${Date.now()}` },
      });

    const signature = await user.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(appWithBadRole)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.include("Invalid role");
  });

  it("fails verification if middleware signer is not operator", async function () {
    const nonOperatorClient = new IdentityClient({
      rpcUrl,
      privateKey: nonOperatorWallet.privateKey,
      identityAddress: identityClient.contract.target,
    });
    const nonOperatorApp = buildApp(nonOperatorClient);

    const user = ethers.Wallet.createRandom();
    const requestRes = await request(nonOperatorApp)
      .post("/api/kyc/request")
      .send({
        walletAddress: user.address,
        requestedRole: "TRADER",
        identityData: { identifier: `non-operator-${Date.now()}` },
      });

    const signature = await user.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(nonOperatorApp)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.include("not an operator");
  });

  it("revokes a whitelisted user and reflects state change on-chain", async function () {
    const user = ethers.Wallet.createRandom();
    const { verifyRes } = await requestAndVerify(app, user, "TRADER", {
      identifier: `revoke-${Date.now()}`,
    });
    expect(verifyRes.status).to.equal(200);
    expect(await identityClient.isWhitelisted(user.address)).to.equal(true);

    const revokeRes = await request(app)
      .post("/api/kyc/revoke")
      .send({ walletAddress: user.address, reason: "manual_besu_revoke" });

    expect(revokeRes.status).to.equal(200);
    expect(revokeRes.body.revoked).to.equal(true);

    const onChainWhitelisted = await identityClient.isWhitelisted(user.address);
    expect(onChainWhitelisted).to.equal(false);
  });

  it("serves users endpoint with on-chain and local state after verify", async function () {
    const user = ethers.Wallet.createRandom();
    const { verifyRes } = await requestAndVerify(app, user, "REGULATOR", {
      identifier: `users-${Date.now()}`,
    });
    expect(verifyRes.status).to.equal(200);

    const usersRes = await request(app).get(`/api/kyc/users/${user.address}`);
    expect(usersRes.status).to.equal(200);
    expect(usersRes.body.walletAddress).to.equal(user.address);
    expect(usersRes.body.onChainWhitelisted).to.equal(true);
    expect(usersRes.body.local.role).to.equal("REGULATOR");
  });

  it("records expected audit actions across request and verify", async function () {
    const user = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({
        walletAddress: user.address,
        requestedRole: "TRADER",
        identityData: { identifier: `audit-${Date.now()}` },
      });

    expect(requestRes.status).to.equal(200);
    const signature = await user.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });
    expect(verifyRes.status).to.equal(200);

    const auditRes = await request(app).get("/api/kyc/audit?limit=50&offset=0");
    expect(auditRes.status).to.equal(200);
    const actions = auditRes.body.entries.map((entry) => entry.action);
    expect(actions).to.include("kyc_request_created");
    expect(actions).to.include("kyc_approved");
  });

  it("reverify easy path refreshes attestation for whitelisted user", async function () {
    const user = ethers.Wallet.createRandom();
    const { verifyRes } = await requestAndVerify(app, user, "TRADER", {
      identifier: `easy-reverify-${Date.now()}`,
    });
    expect(verifyRes.status).to.equal(200);

    const reverifyRes = await request(app)
      .post("/api/kyc/reverify")
      .send({ walletAddress: user.address, attestationDays: 9 });

    expect(reverifyRes.status).to.equal(200);
    expect(reverifyRes.body.mode).to.equal("easy");
    expect(reverifyRes.body.attestationTx.txHash).to.match(/^0x/);
  });

  it("reverify strict path re-runs verification and re-whitelists", async function () {
    // Use funded signer from Besu keys so it can set on-chain preference.
    const strictUser = nonOperatorWallet;
    const strictIdentityContract = identityClient.contract.connect(strictUser);
    await strictIdentityContract.setReverificationPreference(false);

    const { verifyRes } = await requestAndVerify(app, strictUser, "ISSUER", {
      identifier: `strict-reverify-initial-${Date.now()}`,
    });
    expect(verifyRes.status).to.equal(200);

    const reverifyRes = await request(app)
      .post("/api/kyc/reverify")
      .send({
        walletAddress: strictUser.address,
        identityData: { identifier: `strict-reverify-renew-${Date.now()}` },
      });

    expect(reverifyRes.status).to.equal(200);
    expect(reverifyRes.body.mode).to.equal("strict");
    expect(reverifyRes.body.whitelistTx.txHash).to.match(/^0x/);
    const onChainWhitelisted = await identityClient.isWhitelisted(strictUser.address);
    expect(onChainWhitelisted).to.equal(true);
  });

  it("returns 400 for malformed signature payload", async function () {
    const user = ethers.Wallet.createRandom();
    const requestRes = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: user.address, requestedRole: "TRADER", identityData: { identifier: `malformed-${Date.now()}` } });
    expect(requestRes.status).to.equal(200);

    const verifyRes = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature: "not-a-signature" });

    expect(verifyRes.status).to.equal(400);
  });

  it("invalidates old signature after issuing a new challenge", async function () {
    const user = ethers.Wallet.createRandom();
    const firstReq = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: user.address, requestedRole: "TRADER", identityData: { identifier: `challenge1-${Date.now()}` } });
    expect(firstReq.status).to.equal(200);
    const firstSig = await user.signMessage(firstReq.body.challengeMessage);

    const secondReq = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: user.address, requestedRole: "TRADER", identityData: { identifier: `challenge2-${Date.now()}` } });
    expect(secondReq.status).to.equal(200);

    const staleVerify = await request(app)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature: firstSig });
    expect(staleVerify.status).to.equal(400);
    expect(staleVerify.body.error).to.equal("Wallet signature mismatch");
  });

  it("returns 400 on strict reverify when provider rejects renewal", async function () {
    const strictUser = nonOperatorWallet;
    const strictIdentityContract = identityClient.contract.connect(strictUser);
    await strictIdentityContract.setReverificationPreference(false);

    const { verifyRes } = await requestAndVerify(app, strictUser, "ISSUER", {
      identifier: `strict-reject-initial-${Date.now()}`,
    });
    expect(verifyRes.status).to.equal(200);

    const rejectingProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        return { approved: false, reason: "Sanctions or PEP check failed" };
      },
    };
    const rejectingApp = buildApp(identityClient, rejectingProvider);

    const reverifyRes = await request(rejectingApp)
      .post("/api/kyc/reverify")
      .send({ walletAddress: strictUser.address, identityData: { identifier: `strict-reject-renew-${Date.now()}` } });

    expect(reverifyRes.status).to.equal(403);
    expect(reverifyRes.body.approved).to.equal(false);
    expect(await identityClient.isWhitelisted(strictUser.address)).to.equal(true);
  });

  it("returns 400 when provider throws in verify flow", async function () {
    const failingProvider = {
      name: "simulated-eidas",
      async verifyIdentity() {
        throw new Error("Provider offline");
      },
    };

    const failingApp = buildApp(identityClient, failingProvider);
    const user = ethers.Wallet.createRandom();
    const requestRes = await request(failingApp)
      .post("/api/kyc/request")
      .send({ walletAddress: user.address, requestedRole: "TRADER", identityData: { identifier: `provider-throw-${Date.now()}` } });
    expect(requestRes.status).to.equal(200);

    const signature = await user.signMessage(requestRes.body.challengeMessage);
    const verifyRes = await request(failingApp)
      .post("/api/kyc/verify")
      .send({ walletAddress: user.address, signature });

    expect(verifyRes.status).to.equal(400);
    expect(verifyRes.body.error).to.equal("Provider offline");
    expect(await identityClient.isWhitelisted(user.address)).to.equal(false);
  });

  it("rejects invalid wallet on users endpoint", async function () {
    const response = await request(app).get("/api/kyc/users/not-an-address");
    expect(response.status).to.equal(400);
    expect(response.body.error).to.equal("Invalid wallet address");
  });
});
