const { expect } = require("chai");
const request = require("supertest");

const createApp = require("../../middleware/src/app");
const { createAuth, parseApiKeys } = require("../../middleware/src/security/auth");
const { createRateLimiters } = require("../../middleware/src/security/rateLimit");
const { resetStore } = require("../../middleware/src/state/store");

describe("Middleware: security controls", function () {
  beforeEach(function () {
    resetStore();
  });

  it("parses API keys and roles", function () {
    const map = parseApiKeys("client-key:CLIENT;ops-key:OPERATOR,REGULATOR");
    expect(map.has("client-key")).to.equal(true);
    expect(map.get("client-key").has("CLIENT")).to.equal(true);
    expect(map.get("ops-key").has("OPERATOR")).to.equal(true);
    expect(map.get("ops-key").has("REGULATOR")).to.equal(true);
  });

  it("enforces auth on protected endpoints", async function () {
    const identityClient = {
      signer: { address: "0x0000000000000000000000000000000000000009" },
      contract: {
        target: "0x0000000000000000000000000000000000000010",
        filters: {
          UserWhitelisted: () => ({}),
          UserRevoked: () => ({}),
          AttestationUpdated: () => ({}),
        },
        queryFilter: async () => [],
      },
      provider: { getBlockNumber: async () => 1 },
      whitelist: async () => ({ txHash: "0x1", blockNumber: 1, role: "TRADER" }),
      updateAttestation: async () => ({ txHash: "0x2", blockNumber: 2 }),
      revoke: async () => ({ txHash: "0x3", blockNumber: 3 }),
      prefersEasyReverification: async () => true,
      isWhitelisted: async () => true,
    };

    const providerAdapter = {
      name: "simulated-eidas",
      verifyIdentity: async () => ({ approved: true, role: "TRADER", provider: "simulated-eidas", evidenceId: "SIM-1" }),
    };

    const auth = createAuth({
      enabled: true,
      keyMap: parseApiKeys("client-key:CLIENT;op-key:OPERATOR;reg-key:REGULATOR"),
    });
    const rateLimiters = createRateLimiters({ enabled: false });

    const { app } = createApp({
      identityClient,
      providerAdapter,
      auth,
      rateLimiters,
      config: {
        port: 8080,
        attestationDays: 30,
        challengeTtlSeconds: 120,
        corsOrigin: "*",
        persistEnabled: false,
        persistFilePath: "middleware/data/test-store.json",
        reconciliationIntervalMs: 0,
      },
    });

    const unauthorized = await request(app)
      .post("/api/kyc/request")
      .send({ walletAddress: "0x0000000000000000000000000000000000000001", identityData: { identifier: "x" } });
    expect(unauthorized.status).to.equal(401);

    const forbidden = await request(app)
      .post("/api/kyc/revoke")
      .set("x-api-key", "client-key")
      .send({ walletAddress: "0x0000000000000000000000000000000000000001" });
    expect(forbidden.status).to.equal(403);

    const allowed = await request(app)
      .post("/api/kyc/request")
      .set("x-api-key", "client-key")
      .send({ walletAddress: "0x0000000000000000000000000000000000000001", identityData: { identifier: "x" } });
    expect(allowed.status).to.equal(200);

    const usersForbidden = await request(app)
      .get("/api/kyc/users/0x0000000000000000000000000000000000000001")
      .set("x-api-key", "client-key");
    expect(usersForbidden.status).to.equal(403);

    const usersAllowed = await request(app)
      .get("/api/kyc/users/0x0000000000000000000000000000000000000001")
      .set("x-api-key", "reg-key");
    expect(usersAllowed.status).to.equal(200);

    const reconcileForbidden = await request(app)
      .post("/api/kyc/reconcile")
      .set("x-api-key", "client-key");
    expect(reconcileForbidden.status).to.equal(403);

    const reconcileAllowed = await request(app)
      .post("/api/kyc/reconcile")
      .set("x-api-key", "op-key");
    expect(reconcileAllowed.status).to.equal(200);
    expect(reconcileAllowed.body.ok).to.equal(true);
  });

  it("enforces request rate limits", async function () {
    const identityClient = {
      signer: { address: "0x0000000000000000000000000000000000000009" },
      contract: {
        target: "0x0000000000000000000000000000000000000010",
        filters: {
          UserWhitelisted: () => ({}),
          UserRevoked: () => ({}),
          AttestationUpdated: () => ({}),
        },
        queryFilter: async () => [],
      },
      provider: { getBlockNumber: async () => 1 },
      whitelist: async () => ({ txHash: "0x1", blockNumber: 1, role: "TRADER" }),
      updateAttestation: async () => ({ txHash: "0x2", blockNumber: 2 }),
      revoke: async () => ({ txHash: "0x3", blockNumber: 3 }),
      prefersEasyReverification: async () => true,
      isWhitelisted: async () => true,
    };

    const providerAdapter = {
      name: "simulated-eidas",
      verifyIdentity: async () => ({ approved: true, role: "TRADER", provider: "simulated-eidas", evidenceId: "SIM-1" }),
    };

    const auth = createAuth({
      enabled: true,
      keyMap: parseApiKeys("client-key:CLIENT"),
    });

    const rateLimiters = createRateLimiters({
      enabled: true,
      windowMs: 60000,
      globalMax: 100,
      challengeMax: 2,
      verifyMax: 100,
    });

    const { app } = createApp({
      identityClient,
      providerAdapter,
      auth,
      rateLimiters,
      config: {
        port: 8080,
        attestationDays: 30,
        challengeTtlSeconds: 120,
        corsOrigin: "*",
        persistEnabled: false,
        persistFilePath: "middleware/data/test-store.json",
        reconciliationIntervalMs: 0,
      },
    });

    const body = {
      walletAddress: "0x0000000000000000000000000000000000000001",
      identityData: { identifier: "x" },
    };

    const first = await request(app).post("/api/kyc/request").set("x-api-key", "client-key").send(body);
    const second = await request(app).post("/api/kyc/request").set("x-api-key", "client-key").send(body);
    const third = await request(app).post("/api/kyc/request").set("x-api-key", "client-key").send(body);

    expect(first.status).to.equal(200);
    expect(second.status).to.equal(200);
    expect(third.status).to.equal(429);
  });
});
