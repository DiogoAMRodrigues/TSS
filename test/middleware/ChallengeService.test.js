const { expect } = require("chai");
const { ethers } = require("ethers");
const { buildChallenge, verifySignedChallenge } = require("../../middleware/src/services/challengeService");
const { challenges, resetStore, toKey } = require("../../middleware/src/state/store");

describe("Middleware: challengeService", function () {
  beforeEach(function () {
    resetStore();
  });

  it("creates a challenge with a TTL", function () {
    const wallet = "0x0000000000000000000000000000000000000001";
    const result = buildChallenge(wallet, 60);

    expect(result.message).to.include("TSS KYC wallet challenge");
    expect(result.message).to.include(`wallet=${wallet}`);
    expect(result.expiresAt).to.be.greaterThan(Date.now());
    expect(challenges.has(toKey(wallet))).to.equal(true);
  });

  it("verifies a valid signature and marks challenge as used", async function () {
    const user = ethers.Wallet.createRandom();
    const { message } = buildChallenge(user.address, 60);
    const signature = await user.signMessage(message);

    const challenge = verifySignedChallenge(user.address, signature);

    expect(challenge.used).to.equal(true);
    expect(challenges.get(toKey(user.address)).used).to.equal(true);
  });

  it("accepts checksum/lowercase address variants for the same signer", async function () {
    const user = ethers.Wallet.createRandom();
    const checksum = ethers.getAddress(user.address);
    const lower = user.address.toLowerCase();

    const { message } = buildChallenge(checksum, 60);
    const signature = await user.signMessage(message);

    const challenge = verifySignedChallenge(lower, signature);
    expect(challenge.used).to.equal(true);
  });

  it("rejects invalid signer", async function () {
    const user = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const { message } = buildChallenge(user.address, 60);
    const badSignature = await attacker.signMessage(message);

    expect(() => verifySignedChallenge(user.address, badSignature)).to.throw("Wallet signature mismatch");
  });

  it("rejects reused challenge", async function () {
    const user = ethers.Wallet.createRandom();
    const { message } = buildChallenge(user.address, 60);
    const signature = await user.signMessage(message);

    verifySignedChallenge(user.address, signature);
    expect(() => verifySignedChallenge(user.address, signature)).to.throw("Challenge already used");
  });

  it("rejects expired challenge", async function () {
    const user = ethers.Wallet.createRandom();
    const { message } = buildChallenge(user.address, 0);
    const signature = await user.signMessage(message);

    const key = toKey(user.address);
    const entry = challenges.get(key);
    entry.expiresAt = Date.now() - 1;
    challenges.set(key, entry);

    expect(() => verifySignedChallenge(user.address, signature)).to.throw("Challenge expired");
  });

  it("rejects when challenge does not exist", function () {
    expect(() => verifySignedChallenge("0x0000000000000000000000000000000000000001", "0xdeadbeef")).to.throw(
      "No active challenge for wallet"
    );
  });
});
