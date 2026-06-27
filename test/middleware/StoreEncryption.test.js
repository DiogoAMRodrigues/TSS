const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  users,
  getMeta,
  resetStore,
  configureStore,
  persistNow,
} = require("../../middleware/src/state/store");

// 32-byte key, deliberately distinct from the in-code development key.
const TEST_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";

const REL_PATH = "middleware/data/test-encrypt-store.json";
const ABS_PATH = path.resolve(process.cwd(), REL_PATH);

const WALLET = "0x00000000000000000000000000000000000000aa";
const SECRET_NIC = "NIC-SECRET-123456";
const SECRET_NAME = "Jane Doe Secret";

function removeFile() {
  if (fs.existsSync(ABS_PATH)) {
    fs.unlinkSync(ABS_PATH);
  }
}

describe("Middleware: store encryption at rest", function () {
  beforeEach(function () {
    removeFile();
    resetStore();
  });

  after(function () {
    // Restore the default no-persistence state so sibling suites are unaffected.
    configureStore({ persistEnabled: false });
    resetStore();
    removeFile();
  });

  it("writes the persisted store as an AES-256-GCM envelope with no plaintext PII", function () {
    configureStore({
      persistEnabled: true,
      persistFilePath: REL_PATH,
      encryptionKey: TEST_KEY,
    });

    users.set(WALLET, {
      walletAddress: WALLET,
      nic: SECRET_NIC,
      nomeCompleto: SECRET_NAME,
      attestationHash: "0xdeadbeef",
      attestationSalt: "abc123",
    });
    persistNow();

    const raw = fs.readFileSync(ABS_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.alg).to.equal("aes-256-gcm");
    expect(parsed).to.have.property("iv").that.is.a("string");
    expect(parsed).to.have.property("tag").that.is.a("string");
    expect(parsed).to.have.property("ciphertext").that.is.a("string");

    expect(raw).to.not.include(SECRET_NIC);
    expect(raw).to.not.include(SECRET_NAME);
  });

  it("decrypts the envelope on reload (roundtrip)", function () {
    configureStore({
      persistEnabled: true,
      persistFilePath: REL_PATH,
      encryptionKey: TEST_KEY,
    });

    users.set(WALLET, {
      walletAddress: WALLET,
      nic: SECRET_NIC,
      nomeCompleto: SECRET_NAME,
    });
    persistNow();

    // Drop the in-memory copy, then reload purely from the encrypted file.
    users.clear();
    expect(users.has(WALLET)).to.equal(false);

    configureStore({
      persistEnabled: true,
      persistFilePath: REL_PATH,
      encryptionKey: TEST_KEY,
    });

    const restored = users.get(WALLET);
    expect(restored).to.be.an("object");
    expect(restored.nic).to.equal(SECRET_NIC);
    expect(restored.nomeCompleto).to.equal(SECRET_NAME);
  });

  it("auto-migrates a legacy plaintext store to an encrypted envelope on load", function () {
    // Simulate a pre-encryption store written by an older build.
    const legacySnapshot = {
      challenges: [],
      kycCases: [],
      users: [[WALLET, { walletAddress: WALLET, nic: SECRET_NIC }]],
      auditLog: [],
      meta: { lastProcessedBlock: 7 },
    };
    fs.mkdirSync(path.dirname(ABS_PATH), { recursive: true });
    fs.writeFileSync(ABS_PATH, JSON.stringify(legacySnapshot, null, 2));

    // Sanity: the seeded file is plaintext and exposes the PII.
    expect(fs.readFileSync(ABS_PATH, "utf-8")).to.include(SECRET_NIC);

    configureStore({
      persistEnabled: true,
      persistFilePath: REL_PATH,
      encryptionKey: TEST_KEY,
    });

    // Legacy data is loaded correctly.
    expect(users.get(WALLET).nic).to.equal(SECRET_NIC);
    expect(getMeta().lastProcessedBlock).to.equal(7);

    // And the file on disk has been re-encrypted (no plaintext PII left).
    const migrated = fs.readFileSync(ABS_PATH, "utf-8");
    expect(JSON.parse(migrated).alg).to.equal("aes-256-gcm");
    expect(migrated).to.not.include(SECRET_NIC);
  });
});
