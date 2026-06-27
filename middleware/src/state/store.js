const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const challenges = new Map();
const kycCases = new Map();
const users = new Map();
const auditLog = [];
const meta = {
  lastProcessedBlock: 0,
};

let persistEnabled = false;
let persistFilePath = path.resolve(process.cwd(), "middleware", "data", "store.json");
let encryptionKey = null;

// Persistence must survive process restarts, so the development fallback key is
// fixed rather than random. It is refused in production (see loadEncryptionKey).
const DEV_STORE_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

function toKey(address) {
  return String(address || "").toLowerCase();
}

// Resolve the 32-byte AES key used to encrypt the off-chain store at rest.
// Mirrors the operator-key guard in identityClient.js: a real key is required in
// production, and the known development key is refused there unless explicitly
// allowed.
function loadEncryptionKey(explicitKey) {
  const hex = explicitKey || process.env.STORE_ENCRYPTION_KEY || null;
  const allowDevKeys =
    String(process.env.ALLOW_DEV_KEYS || "false").toLowerCase() === "true";

  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("STORE_ENCRYPTION_KEY must be a 32-byte hex string");
    }
    if (
      process.env.NODE_ENV === "production" &&
      hex.toLowerCase() === DEV_STORE_KEY &&
      !allowDevKeys
    ) {
      throw new Error("Refusing to start with known development store key in production");
    }
    return Buffer.from(hex, "hex");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("STORE_ENCRYPTION_KEY is required when persistence is enabled");
  }

  console.warn(
    "[store] STORE_ENCRYPTION_KEY not set; using insecure development key. Do not use in production."
  );
  return Buffer.from(DEV_STORE_KEY, "hex");
}

function encryptSnapshot(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptEnvelope(envelope) {
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

function isEnvelope(parsed) {
  return Boolean(
    parsed &&
      parsed.alg === "aes-256-gcm" &&
      typeof parsed.iv === "string" &&
      typeof parsed.tag === "string" &&
      typeof parsed.ciphertext === "string"
  );
}

function writeAudit(entry) {
  auditLog.push({
    id: auditLog.length + 1,
    timestamp: new Date().toISOString(),
    ...entry,
  });
  persistNow();
}

function ensurePersistDir() {
  const dir = path.dirname(persistFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function serializeMap(map) {
  return Array.from(map.entries());
}

function deserializeIntoMap(map, entries) {
  map.clear();
  for (const [key, value] of entries || []) {
    map.set(key, value);
  }
}

function applySnapshot(parsed) {
  deserializeIntoMap(challenges, parsed.challenges);
  deserializeIntoMap(kycCases, parsed.kycCases);
  deserializeIntoMap(users, parsed.users);

  auditLog.length = 0;
  for (const item of parsed.auditLog || []) {
    auditLog.push(item);
  }

  meta.lastProcessedBlock = Number(parsed.meta?.lastProcessedBlock || 0);
}

function loadFromDisk() {
  if (!persistEnabled) {
    return;
  }
  if (!fs.existsSync(persistFilePath)) {
    return;
  }

  const raw = fs.readFileSync(persistFilePath, "utf-8");
  if (!raw.trim()) {
    return;
  }

  const parsed = JSON.parse(raw);

  if (isEnvelope(parsed)) {
    applySnapshot(JSON.parse(decryptEnvelope(parsed)));
    return;
  }

  // Legacy plaintext store: load it, then re-encrypt on disk (auto-migration).
  applySnapshot(parsed);
  persistNow();
}

function persistNow() {
  if (!persistEnabled) {
    return;
  }
  ensurePersistDir();
  const snapshot = {
    challenges: serializeMap(challenges),
    kycCases: serializeMap(kycCases),
    users: serializeMap(users),
    auditLog,
    meta,
  };
  const envelope = encryptSnapshot(JSON.stringify(snapshot));
  fs.writeFileSync(persistFilePath, JSON.stringify(envelope, null, 2));
}

function configureStore(options = {}) {
  if (typeof options.persistEnabled === "boolean") {
    persistEnabled = options.persistEnabled;
  }
  if (options.persistFilePath) {
    persistFilePath = path.resolve(process.cwd(), options.persistFilePath);
  }
  if (persistEnabled) {
    encryptionKey = loadEncryptionKey(options.encryptionKey);
  }
  loadFromDisk();
}

function getMeta() {
  return { ...meta };
}

function setLastProcessedBlock(blockNumber) {
  meta.lastProcessedBlock = Number(blockNumber || 0);
  persistNow();
}

function resetStore() {
  challenges.clear();
  kycCases.clear();
  users.clear();
  auditLog.length = 0;
  meta.lastProcessedBlock = 0;
  persistNow();
}

module.exports = {
  challenges,
  kycCases,
  users,
  auditLog,
  toKey,
  writeAudit,
  resetStore,
  configureStore,
  persistNow,
  getMeta,
  setLastProcessedBlock,
};
