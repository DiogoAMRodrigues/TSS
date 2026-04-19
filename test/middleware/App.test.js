const { expect } = require("chai");
const request = require("supertest");

const createApp = require("../../middleware/src/app");
const { resetStore } = require("../../middleware/src/state/store");

describe("Middleware: app bootstrap", function () {
  beforeEach(function () {
    resetStore();
  });

  it("buildConfig uses default values when env is absent", function () {
    const prevPort = process.env.MIDDLEWARE_PORT;
    const prevAttestation = process.env.ATTESTATION_DAYS;
    const prevTtl = process.env.CHALLENGE_TTL_SECONDS;
    const prevPersist = process.env.STORE_PERSIST_ENABLED;
    const prevCors = process.env.CORS_ORIGIN;
    const prevReconcile = process.env.RECONCILE_INTERVAL_MS;

    delete process.env.MIDDLEWARE_PORT;
    delete process.env.ATTESTATION_DAYS;
    delete process.env.CHALLENGE_TTL_SECONDS;
    delete process.env.STORE_PERSIST_ENABLED;
    delete process.env.CORS_ORIGIN;
    delete process.env.RECONCILE_INTERVAL_MS;

    const cfg = createApp.buildConfig();
    expect(cfg.port).to.equal(8080);
    expect(cfg.attestationDays).to.equal(90);
    expect(cfg.challengeTtlSeconds).to.equal(300);
    expect(cfg.corsOrigin).to.equal("*");
    expect(cfg.persistFilePath).to.equal("middleware/data/store.json");
    expect(cfg.reconciliationIntervalMs).to.equal(0);

    process.env.MIDDLEWARE_PORT = prevPort;
    process.env.ATTESTATION_DAYS = prevAttestation;
    process.env.CHALLENGE_TTL_SECONDS = prevTtl;
    process.env.STORE_PERSIST_ENABLED = prevPersist;
    process.env.CORS_ORIGIN = prevCors;
    process.env.RECONCILE_INTERVAL_MS = prevReconcile;
  });

  it("buildConfig parses env values", function () {
    process.env.MIDDLEWARE_PORT = "9191";
    process.env.ATTESTATION_DAYS = "45";
    process.env.CHALLENGE_TTL_SECONDS = "111";
    process.env.STORE_PERSIST_ENABLED = "false";
    process.env.CORS_ORIGIN = "http://localhost:5173";
    process.env.RECONCILE_INTERVAL_MS = "60000";

    const cfg = createApp.buildConfig();
    expect(cfg.port).to.equal(9191);
    expect(cfg.attestationDays).to.equal(45);
    expect(cfg.challengeTtlSeconds).to.equal(111);
    expect(cfg.persistEnabled).to.equal(false);
    expect(cfg.corsOrigin).to.equal("http://localhost:5173");
    expect(cfg.reconciliationIntervalMs).to.equal(60000);
  });

  it("createApp accepts injected dependencies and exposes health endpoints", async function () {
    const fakeIdentityClient = {
      signer: { address: "0x0000000000000000000000000000000000000009" },
      contract: { target: "0x0000000000000000000000000000000000000010" },
      whitelist: async () => ({ txHash: "0x1", blockNumber: 1, role: "TRADER" }),
      updateAttestation: async () => ({ txHash: "0x2", blockNumber: 2 }),
      revoke: async () => ({ txHash: "0x3", blockNumber: 3 }),
      prefersEasyReverification: async () => true,
      isWhitelisted: async () => true,
    };

    const fakeProvider = {
      name: "simulated-eidas",
      verifyIdentity: async () => ({ approved: true, role: "TRADER", provider: "simulated-eidas", evidenceId: "SIM-1" }),
    };

    const { app, config } = createApp({
      identityClient: fakeIdentityClient,
      providerAdapter: fakeProvider,
      config: {
        port: 7777,
        attestationDays: 10,
        challengeTtlSeconds: 60,
        corsOrigin: "*",
        persistEnabled: false,
        persistFilePath: "middleware/data/test-store.json",
        reconciliationIntervalMs: 0,
      },
    });

    expect(config.port).to.equal(7777);

    const rootHealth = await request(app).get("/health");
    expect(rootHealth.status).to.equal(200);
    expect(rootHealth.body.service).to.equal("tss-kyc-middleware");

    const kycHealth = await request(app).get("/api/kyc/health");
    expect(kycHealth.status).to.equal(200);
    expect(kycHealth.body.provider).to.equal("simulated-eidas");
  });
});
