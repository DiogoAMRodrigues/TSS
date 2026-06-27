const { expect } = require("chai");
const sinon = require("sinon");
const { ethers } = require("ethers");

const IdentityClient = require("../../middleware/src/services/identityClient");
const { normalizeRole } = require("../../middleware/src/services/identityClient");
const { computeAttestationHash, generateAttestationSalt } = require("../../middleware/src/services/identityClient");

describe("Middleware: IdentityClient", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("normalizes valid roles", function () {
    expect(normalizeRole("trader")).to.equal("TRADER");
    expect(normalizeRole("ISSUER")).to.equal("ISSUER");
  });

  it("throws for invalid roles", function () {
    expect(() => normalizeRole("HACKER")).to.throw("Invalid role 'HACKER'");
  });

  it("throws when required env values are missing", function () {
    const previousKey = process.env.OPERATOR_PRIVATE_KEY;
    const previousKeyFile = process.env.OPERATOR_PRIVATE_KEY_FILE;
    const previousAddress = process.env.IDENTITY_ADDRESS;

    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.OPERATOR_PRIVATE_KEY_FILE;
    delete process.env.IDENTITY_ADDRESS;

    expect(() => new IdentityClient()).to.throw("OPERATOR_PRIVATE_KEY is required");

    if (previousKey === undefined) delete process.env.OPERATOR_PRIVATE_KEY;
    else process.env.OPERATOR_PRIVATE_KEY = previousKey;
    if (previousKeyFile === undefined) delete process.env.OPERATOR_PRIVATE_KEY_FILE;
    else process.env.OPERATOR_PRIVATE_KEY_FILE = previousKeyFile;
    if (previousAddress === undefined) delete process.env.IDENTITY_ADDRESS;
    else process.env.IDENTITY_ADDRESS = previousAddress;
  });

  it("throws when private key format is invalid", function () {
    const previousKey = process.env.OPERATOR_PRIVATE_KEY;
    const previousAddress = process.env.IDENTITY_ADDRESS;

    process.env.OPERATOR_PRIVATE_KEY = "invalid-key";
    process.env.IDENTITY_ADDRESS = "0x0000000000000000000000000000000000000001";

    expect(() => new IdentityClient()).to.throw("OPERATOR_PRIVATE_KEY must be a 32-byte hex string");

    process.env.OPERATOR_PRIVATE_KEY = previousKey;
    process.env.IDENTITY_ADDRESS = previousAddress;
  });

  it("rejects known dev keys in production unless explicitly allowed", function () {
    const previousEnv = {
      OPERATOR_PRIVATE_KEY: process.env.OPERATOR_PRIVATE_KEY,
      IDENTITY_ADDRESS: process.env.IDENTITY_ADDRESS,
      NODE_ENV: process.env.NODE_ENV,
      ALLOW_DEV_KEYS: process.env.ALLOW_DEV_KEYS,
    };

    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_KEYS = "false";
    process.env.OPERATOR_PRIVATE_KEY = "0x1ca60577f0b6dbf9ebddeb330615c25824f2e458eed044b0abc3ac954eb1f3db";
    process.env.IDENTITY_ADDRESS = "0x0000000000000000000000000000000000000001";

    expect(() => new IdentityClient()).to.throw("Refusing to start with known development private key in production");

    process.env.OPERATOR_PRIVATE_KEY = previousEnv.OPERATOR_PRIVATE_KEY;
    process.env.IDENTITY_ADDRESS = previousEnv.IDENTITY_ADDRESS;
    process.env.NODE_ENV = previousEnv.NODE_ENV;
    process.env.ALLOW_DEV_KEYS = previousEnv.ALLOW_DEV_KEYS;
  });

  it("executes whitelist and returns tx metadata", async function () {
    const fakeTx = { hash: "0xabc", wait: sinon.stub().resolves({ blockNumber: 42 }) };
    const contract = { whitelist: sinon.stub().resolves(fakeTx) };
    const client = new IdentityClient({
      provider: {},
      signer: { address: "0x0000000000000000000000000000000000000001" },
      contract,
    });

    const walletAddress = "0x0000000000000000000000000000000000000002";
    const attestationHash = ethers.sha256(ethers.toUtf8Bytes("subject"));
    const result = await client.whitelist(walletAddress, "TRADER", attestationHash);

    expect(contract.whitelist.calledOnce).to.equal(true);
    expect(contract.whitelist.firstCall.args[0]).to.equal(walletAddress);
    expect(contract.whitelist.firstCall.args[1]).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes("TRADER"))
    );
    expect(contract.whitelist.firstCall.args[2]).to.equal(attestationHash);
    expect(result).to.deep.equal({ txHash: "0xabc", blockNumber: 42, role: "TRADER", attestationHash });
  });

  it("defaults the attestation hash to the zero hash when omitted", async function () {
    const fakeTx = { hash: "0xabc", wait: sinon.stub().resolves({ blockNumber: 42 }) };
    const contract = { whitelist: sinon.stub().resolves(fakeTx) };
    const client = new IdentityClient({
      provider: {},
      signer: { address: "0x0000000000000000000000000000000000000001" },
      contract,
    });

    const result = await client.whitelist("0x0000000000000000000000000000000000000002", "TRADER");

    expect(contract.whitelist.firstCall.args[2]).to.equal(ethers.ZeroHash);
    expect(result.attestationHash).to.equal(ethers.ZeroHash);
  });

  it("computes a deterministic, salted attestation hash bound to the wallet", function () {
    const walletAddress = "0x00000000000000000000000000000000000000AB";
    const salt = "00ff";
    const a = computeAttestationHash({ walletAddress, subject: "NIC-123", salt });
    const b = computeAttestationHash({ walletAddress: walletAddress.toLowerCase(), subject: "NIC-123", salt });
    const differentSalt = computeAttestationHash({ walletAddress, subject: "NIC-123", salt: "01ff" });
    const differentSubject = computeAttestationHash({ walletAddress, subject: "NIC-999", salt });

    expect(a).to.match(/^0x[0-9a-f]{64}$/);
    expect(b).to.equal(a); // case-insensitive on the wallet address
    expect(differentSalt).to.not.equal(a);
    expect(differentSubject).to.not.equal(a);
  });

  it("generates a 32-byte random attestation salt", function () {
    const s1 = generateAttestationSalt();
    const s2 = generateAttestationSalt();
    expect(s1).to.match(/^[0-9a-f]{64}$/);
    expect(s2).to.not.equal(s1);
  });

  it("executes updateAttestation and revoke", async function () {
    const updateTx = { hash: "0xdef", wait: sinon.stub().resolves({ blockNumber: 17 }) };
    const revokeTx = { hash: "0x987", wait: sinon.stub().resolves({ blockNumber: 18 }) };
    const contract = {
      updateAttestation: sinon.stub().resolves(updateTx),
      revoke: sinon.stub().resolves(revokeTx),
      prefersEasyReverification: sinon.stub().resolves(true),
      isWhitelisted: sinon.stub().resolves(true),
    };

    const client = new IdentityClient({
      provider: {},
      signer: { address: "0x0000000000000000000000000000000000000001" },
      contract,
    });

    const update = await client.updateAttestation("0x0000000000000000000000000000000000000002", 12345);
    const revoke = await client.revoke("0x0000000000000000000000000000000000000002");
    const easy = await client.prefersEasyReverification("0x0000000000000000000000000000000000000002");
    const whitelisted = await client.isWhitelisted("0x0000000000000000000000000000000000000002");

    expect(update).to.deep.equal({ txHash: "0xdef", blockNumber: 17, expiryUnixSeconds: 12345 });
    expect(revoke).to.deep.equal({ txHash: "0x987", blockNumber: 18 });
    expect(easy).to.equal(true);
    expect(whitelisted).to.equal(true);
  });
});
