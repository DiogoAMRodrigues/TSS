const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const IdentityClient = require("./services/identityClient");
const SimulatedEidasProvider = require("./providers/simulatedEidasProvider");
const RealEidasProvider = require("./providers/realEidasProvider");
const createKycRouter = require("./routes/kycRoutes");
const createEidasRouter = require("./routes/eidasRoutes");
const { configureStore } = require("./state/store");
const { createAuth } = require("./security/auth");
const { createRateLimiters } = require("./security/rateLimit");
const { createReconciliationService } = require("./services/reconciliationService");

dotenv.config({ path: path.resolve(process.cwd(), "middleware/.env") });
dotenv.config();

function buildConfig() {
  const corsOrigin = process.env.CORS_ORIGIN || "*";
  const defaultPersistEnabled = process.env.NODE_ENV !== "test";
  return {
    port: Number(process.env.MIDDLEWARE_PORT || 8080),
    attestationDays: Number(process.env.ATTESTATION_DAYS || 90),
    challengeTtlSeconds: Number(process.env.CHALLENGE_TTL_SECONDS || 300),
    corsOrigin,
    persistEnabled: String(
      process.env.STORE_PERSIST_ENABLED || String(defaultPersistEnabled)
    ).toLowerCase() !== "false",
    persistFilePath: process.env.STORE_PERSIST_FILE || "middleware/data/store.json",
    reconciliationIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 0),
  };
}

function createApp(options = {}) {
  const config = options.config || buildConfig();
  configureStore({
    persistEnabled: config.persistEnabled,
    persistFilePath: config.persistFilePath,
  });

  const identityClient = options.identityClient || new IdentityClient();
  const providerKind = (process.env.EIDAS_PROVIDER || "simulated").toLowerCase();
  const providerAdapter =
    options.providerAdapter ||
    (providerKind === "real" ? new RealEidasProvider() : new SimulatedEidasProvider());
  const auth = options.auth || createAuth();
  const rateLimiters = options.rateLimiters || createRateLimiters();
  const reconciliationService =
    options.reconciliationService || createReconciliationService(identityClient);

  if (config.reconciliationIntervalMs > 0) {
    reconciliationService.start(config.reconciliationIntervalMs);
  }

  const app = express();

  app.use(
    cors({
      origin: config.corsOrigin === "*" ? true : config.corsOrigin,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, service: "tss-kyc-middleware" });
  });

  app.use(
    "/api/kyc",
    createKycRouter({
      identityClient,
      providerAdapter,
      config,
      auth,
      rateLimiters,
      reconciliationService,
    })
  );

  // Mount eIDAS routes only when the real provider is active
  if (providerKind === "real" && typeof providerAdapter.buildAuthnRequest === "function") {
    app.use(
      "/api/kyc/eidas",
      createEidasRouter({
        identityClient,
        providerAdapter,
        config,
        auth,
        rateLimiters,
      })
    );
  }

  // Static SLO landing page registered with AMA preprod (EIDAS_SP_SLO_URL)
  app.get("/logout", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Logout</title></head><body><h2>Sessão terminada / Session ended</h2></body></html>`
      );
  });

  return { app, config, reconciliationService, auth, rateLimiters };
}

module.exports = createApp;
module.exports.buildConfig = buildConfig;
