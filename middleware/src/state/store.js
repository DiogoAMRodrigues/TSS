const fs = require("fs");
const path = require("path");

const challenges = new Map();
const kycCases = new Map();
const users = new Map();
const auditLog = [];
const meta = {
  lastProcessedBlock: 0,
};

let persistEnabled = false;
let persistFilePath = path.resolve(process.cwd(), "middleware", "data", "store.json");

function toKey(address) {
  return String(address || "").toLowerCase();
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
  deserializeIntoMap(challenges, parsed.challenges);
  deserializeIntoMap(kycCases, parsed.kycCases);
  deserializeIntoMap(users, parsed.users);

  auditLog.length = 0;
  for (const item of parsed.auditLog || []) {
    auditLog.push(item);
  }

  meta.lastProcessedBlock = Number(parsed.meta?.lastProcessedBlock || 0);
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
  fs.writeFileSync(persistFilePath, JSON.stringify(snapshot, null, 2));
}

function configureStore(options = {}) {
  if (typeof options.persistEnabled === "boolean") {
    persistEnabled = options.persistEnabled;
  }
  if (options.persistFilePath) {
    persistFilePath = path.resolve(process.cwd(), options.persistFilePath);
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
