const { expect } = require("chai");
const sinon = require("sinon");
const { ethers } = require("ethers");

const IdentityClient = require("../../middleware/src/services/identityClient");
const { normalizeRole } = require("../../middleware/src/services/identityClient");

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
    const previousAddress = process.env.IDENTITY_ADDRESS;

    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.IDENTITY_ADDRESS;

    expect(() => new IdentityClient()).to.throw("OPERATOR_PRIVATE_KEY is required");

    process.env.OPERATOR_PRIVATE_KEY = previousKey;
    process.env.IDENTITY_ADDRESS = previousAddress;
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
    const result = await client.whitelist(walletAddress, "TRADER");

    expect(contract.whitelist.calledOnce).to.equal(true);
    expect(contract.whitelist.firstCall.args[0]).to.equal(walletAddress);
    expect(contract.whitelist.firstCall.args[1]).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes("TRADER"))
    );
    expect(result).to.deep.equal({ txHash: "0xabc", blockNumber: 42, role: "TRADER" });
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
