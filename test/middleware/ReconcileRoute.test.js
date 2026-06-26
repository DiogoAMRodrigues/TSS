const { expect } = require("chai");
const express = require("express");
const request = require("supertest");
const sinon = require("sinon");

const createKycRouter = require("../../middleware/src/routes/kycRoutes");
const { createReconciliationService } = require("../../middleware/src/services/reconciliationService");
const { resetStore, users } = require("../../middleware/src/state/store");

function buildTestApp({ identityClient, providerAdapter, config, reconciliationService }) {
  const app = express();
  app.use(express.json());
  app.use("/api/kyc", createKycRouter({ identityClient, providerAdapter, config, reconciliationService }));
  return app;
}

describe("Middleware: /reconcile route", function () {
  let identityClient;
  let providerAdapter;
  let config;
  let app;

  beforeEach(function () {
    resetStore();

    identityClient = {
      signer: { address: "0x0000000000000000000000000000000000000009" },
      contract: { target: "0x0000000000000000000000000000000000000010" },
      provider: {
        getBlockNumber: sinon.stub().resolves(20),
      },
    };

    providerAdapter = {
      name: "simulated-eidas",
      verifyIdentity: sinon.stub().resolves({ approved: true, role: "TRADER", provider: "simulated-eidas", evidenceId: "SIM-1" }),
    };

    config = {
      challengeTtlSeconds: 120,
      attestationDays: 30,
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 501 when reconciliation service is not configured", async function () {
    app = buildTestApp({ identityClient, providerAdapter, config, reconciliationService: null });

    const response = await request(app).post("/api/kyc/reconcile");

    expect(response.status).to.equal(501);
    expect(response.body.error).to.equal("Reconciliation service not configured");
  });

  it("returns 200 with reconciliation result on success", async function () {
    const reconciliationService = {
      reconcileOnce: sinon.stub().resolves({
        latestBlock: 50,
        processed: 3,
        fromBlock: 10,
        toBlock: 50,
      }),
    };

    app = buildTestApp({ identityClient, providerAdapter, config, reconciliationService });

    const response = await request(app).post("/api/kyc/reconcile");

    expect(response.status).to.equal(200);
    expect(response.body.ok).to.equal(true);
    expect(response.body.result).to.deep.equal({
      latestBlock: 50,
      processed: 3,
      fromBlock: 10,
      toBlock: 50,
    });
  });

  it("returns 500 when reconcileOnce throws", async function () {
    const reconciliationService = {
      reconcileOnce: sinon.stub().rejects(new Error("provider unavailable")),
    };

    app = buildTestApp({ identityClient, providerAdapter, config, reconciliationService });

    const response = await request(app).post("/api/kyc/reconcile");

    expect(response.status).to.equal(500);
    expect(response.body.error).to.include("provider unavailable");
  });

  it("reconciles on-chain events into local store via route", async function () {
    // Set up identityClient with mock contract methods
    identityClient.contract.filters = {
      UserWhitelisted: () => ({ type: "whitelisted" }),
      UserRevoked: () => ({ type: "revoked" }),
      AttestationUpdated: () => ({ type: "attestation" }),
    };

    identityClient.contract.queryFilter = async (filter) => {
      if (filter.type === "whitelisted") {
        return [
          {
            args: { user: "0x0000000000000000000000000000000000000001" },
            blockNumber: 12,
          },
        ];
      }
      if (filter.type === "revoked") {
        return [];
      }
      if (filter.type === "attestation") {
        return [];
      }
      return [];
    };

    // Create a real reconciliation service with the mocked identityClient
    const reconciliationService = createReconciliationService(identityClient);

    app = buildTestApp({ identityClient, providerAdapter, config, reconciliationService });

    const response = await request(app).post("/api/kyc/reconcile");

    expect(response.status).to.equal(200);
    expect(response.body.ok).to.equal(true);
    expect(response.body.result.processed).to.equal(1);

    // Verify the user was added to the store with correct status
    const user = users.get("0x0000000000000000000000000000000000000001");
    expect(user).to.exist;
    expect(user.kycStatus).to.equal("approved");
    expect(user.walletAddress).to.equal("0x0000000000000000000000000000000000000001");
  });
});
