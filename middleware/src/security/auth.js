const ROLES = {
  CLIENT: "CLIENT",
  OPERATOR: "OPERATOR",
  REGULATOR: "REGULATOR",
  ADMIN: "ADMIN",
};

function parseApiKeys(value) {
  const map = new Map();
  if (!value || !String(value).trim()) {
    return map;
  }

  const pairs = String(value)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const [apiKey, rolePart] = pair.split(":");
    if (!apiKey || !rolePart) {
      continue;
    }

    const roles = rolePart
      .split(",")
      .map((role) => role.trim().toUpperCase())
      .filter(Boolean);

    if (roles.length) {
      map.set(apiKey.trim(), new Set(roles));
    }
  }

  return map;
}

function createAuth(options = {}) {
  const enabled = options.enabled !== undefined
    ? Boolean(options.enabled)
    : String(process.env.MIDDLEWARE_AUTH_ENABLED || "true").toLowerCase() !== "false";

  const keyMap = options.keyMap || parseApiKeys(process.env.MIDDLEWARE_API_KEYS);

  function requireAuth(allowedRoles = []) {
    return (req, res, next) => {
      if (!enabled) {
        req.auth = { disabled: true, roles: new Set() };
        return next();
      }

      const apiKey = req.header("x-api-key");
      if (!apiKey) {
        return res.status(401).json({ error: "Missing x-api-key" });
      }

      const roles = keyMap.get(apiKey);
      if (!roles) {
        return res.status(401).json({ error: "Invalid API key" });
      }

      if (allowedRoles.length) {
        const hasRole = allowedRoles.some((role) => roles.has(String(role).toUpperCase()));
        if (!hasRole) {
          return res.status(403).json({ error: "Insufficient role for this endpoint" });
        }
      }

      req.auth = { apiKey, roles };
      return next();
    };
  }

  return {
    enabled,
    keyMap,
    requireAuth,
  };
}

module.exports = {
  ROLES,
  parseApiKeys,
  createAuth,
};
