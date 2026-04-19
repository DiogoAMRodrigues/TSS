const rateLimit = require("express-rate-limit");

function createRateLimiters(options = {}) {
  const enabled = options.enabled !== undefined
    ? Boolean(options.enabled)
    : String(process.env.MIDDLEWARE_RATE_LIMIT_ENABLED || "true").toLowerCase() !== "false";

  if (!enabled) {
    return {
      globalLimiter: (req, res, next) => next(),
      challengeLimiter: (req, res, next) => next(),
      verifyLimiter: (req, res, next) => next(),
    };
  }

  const windowMs = Number(options.windowMs || process.env.RATE_LIMIT_WINDOW_MS || 60000);
  const globalMax = Number(options.globalMax || process.env.RATE_LIMIT_GLOBAL_MAX || 120);
  const challengeMax = Number(options.challengeMax || process.env.RATE_LIMIT_CHALLENGE_MAX || 30);
  const verifyMax = Number(options.verifyMax || process.env.RATE_LIMIT_VERIFY_MAX || 60);

  const keyGenerator = (req) => {
    const ipPart = rateLimit.ipKeyGenerator(req.ip || "");
    return `${ipPart}|${req.header("x-api-key") || "anon"}`;
  };

  const base = {
    windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { error: "Rate limit exceeded" },
  };

  return {
    globalLimiter: rateLimit({ ...base, max: globalMax }),
    challengeLimiter: rateLimit({ ...base, max: challengeMax }),
    verifyLimiter: rateLimit({ ...base, max: verifyMax }),
  };
}

module.exports = {
  createRateLimiters,
};
