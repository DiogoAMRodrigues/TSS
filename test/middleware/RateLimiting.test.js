const { expect } = require("chai");
const request = require("supertest");

const createApp = require("../../middleware/src/app");
const { createAuth, parseApiKeys } = require("../../middleware/src/security/auth");
const { createRateLimiters } = require("../../middleware/src/security/rateLimit");
const { resetStore } = require("../../middleware/src/state/store");

describe("Middleware: rate limiting", function () {
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

  const config = {
    port: 8080,
    attestationDays: 30,
    challengeTtlSeconds: 120,
    corsOrigin: "*",
    persistEnabled: false,
    persistFilePath: "middleware/data/test-store.json",
    reconciliationIntervalMs: 0,
  };

  const requestBody = {
    walletAddress: "0x0000000000000000000000000000000000000001",
    identityData: { identifier: "x" },
  };

  beforeEach(function () {
    resetStore();
  });

  it("global limiter blocks all routes after max requests", async function () {
    const auth = createAuth({ enabled: false });
    const rateLimiters = createRateLimiters({
      enabled: true,
      windowMs: 60000,
      globalMax: 3,
      challengeMax: 100,
      verifyMax: 100,
    });

    const { app } = createApp({
      identityClient,
      providerAdapter,
      auth,
      rateLimiters,
      config,
    });

    // Make 3 requests to /api/kyc/request (should all pass)
    const first = await request(app).post("/api/kyc/request").send(requestBody);
    expect(first.status).to.equal(200);

    const second = await request(app).post("/api/kyc/request").send(requestBody);
    expect(second.status).to.equal(200);

    const third = await request(app).post("/api/kyc/request").send(requestBody);
    expect(third.status).to.equal(200);

    // 4th request to ANY route should be blocked by global limiter
    const fourth = await request(app).get("/api/kyc/health");
    expect(fourth.status).to.equal(429);
  });

  it("verify limiter blocks /verify after max attempts", async function () {
    const auth = createAuth({ enabled: false });
    const rateLimiters = createRateLimiters({
      enabled: true,
      windowMs: 60000,
      globalMax: 100,
      challengeMax: 100,
      verifyMax: 2,
    });

    const { app } = createApp({
      identityClient,
      providerAdapter,
      auth,
      rateLimiters,
      config,
    });

    // First, make a /request to create a challenge
    const requestRes = await request(app).post("/api/kyc/request").send(requestBody);
    expect(requestRes.status).to.equal(200);
    const challengeId = requestRes.body.challengeId;

    // First verify attempt (will fail with 400 due to invalid signature, but counts against rate limit)
    const verify1 = await request(app)
      .post("/api/kyc/verify")
      .send({
        walletAddress: "0x0000000000000000000000000000000000000001",
        challengeId,
        signature: "invalid-signature-1",
      });
    expect(verify1.status).to.equal(400);

    // Second verify attempt (will fail with 400, but counts against rate limit)
    const verify2 = await request(app)
      .post("/api/kyc/verify")
      .send({
        walletAddress: "0x0000000000000000000000000000000000000001",
        challengeId,
        signature: "invalid-signature-2",
      });
    expect(verify2.status).to.equal(400);

    // Third verify attempt should be blocked by rate limiter
    const verify3 = await request(app)
      .post("/api/kyc/verify")
      .send({
        walletAddress: "0x0000000000000000000000000000000000000001",
        challengeId,
        signature: "invalid-signature-3",
      });
    expect(verify3.status).to.equal(429);
  });

  it("verify limiter blocks /reverify after max attempts", async function () {
    const auth = createAuth({ enabled: false });
    const rateLimiters = createRateLimiters({
      enabled: true,
      windowMs: 60000,
      globalMax: 100,
      challengeMax: 100,
      verifyMax: 2,
    });

    const { app } = createApp({
      identityClient,
      providerAdapter,
      auth,
      rateLimiters,
      config,
    });

    // First reverify attempt (will fail with 400 due to invalid wallet address, but counts against rate limit)
    const reverify1 = await request(app)
      .post("/api/kyc/reverify")
      .send({
        walletAddress: "invalid-address",
      });
    expect(reverify1.status).to.equal(400);

    // Second reverify attempt (will fail with 400, but counts against rate limit)
    const reverify2 = await request(app)
      .post("/api/kyc/reverify")
      .send({
        walletAddress: "invalid-address",
      });
    expect(reverify2.status).to.equal(400);

    // Third reverify attempt should be blocked by rate limiter
    const reverify3 = await request(app)
      .post("/api/kyc/reverify")
      .send({
        walletAddress: "invalid-address",
      });
    expect(reverify3.status).to.equal(429);
  });

  it("disabled rate limiting allows unlimited requests", async function () {
    const auth = createAuth({ enabled: false });
    const rateLimiters = createRateLimiters({ enabled: false });

    const { app } = createApp({
      identityClient,
      providerAdapter,
      auth,
      rateLimiters,
      config,
    });

    // Make 10 requests to /api/kyc/request, all should succeed (not 429)
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/api/kyc/request").send(requestBody);
      expect(res.status).to.equal(200, `Request ${i + 1} should succeed when rate limiting is disabled`);
    }
  });

  it("different API keys have separate rate limit buckets", async function () {
    const auth = createAuth({
      enabled: true,
      keyMap: parseApiKeys("key-a:CLIENT;key-b:CLIENT"),
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
      config,
    });

    // Make 2 requests with key-a (should both pass)
    const keyA1 = await request(app)
      .post("/api/kyc/request")
      .set("x-api-key", "key-a")
      .send(requestBody);
    expect(keyA1.status).to.equal(200);

    const keyA2 = await request(app)
      .post("/api/kyc/request")
      .set("x-api-key", "key-a")
      .send(requestBody);
    expect(keyA2.status).to.equal(200);

    // Make 1 request with key-b (should pass, proving separate buckets)
    const keyB1 = await request(app)
      .post("/api/kyc/request")
      .set("x-api-key", "key-b")
      .send(requestBody);
    expect(keyB1.status).to.equal(200);

    // Make 1 more request with key-a (should be blocked by rate limiter)
    const keyA3 = await request(app)
      .post("/api/kyc/request")
      .set("x-api-key", "key-a")
      .send(requestBody);
    expect(keyA3.status).to.equal(429);
  });
});
