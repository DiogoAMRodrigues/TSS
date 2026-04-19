const crypto = require("crypto");
const { ethers } = require("ethers");
const { challenges, toKey, persistNow } = require("../state/store");

function buildChallenge(walletAddress, ttlSeconds) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlSeconds * 1000;
  const message = [
    "TSS KYC wallet challenge",
    `wallet=${walletAddress}`,
    `nonce=${nonce}`,
    `issuedAt=${issuedAt}`,
  ].join("\n");

  const key = toKey(walletAddress);
  challenges.set(key, {
    walletAddress,
    nonce,
    issuedAt,
    expiresAt,
    message,
    used: false,
  });
  persistNow();

  return { message, expiresAt };
}

function verifySignedChallenge(walletAddress, signature) {
  const key = toKey(walletAddress);
  const challenge = challenges.get(key);

  if (!challenge) {
    throw new Error("No active challenge for wallet");
  }

  if (challenge.used) {
    throw new Error("Challenge already used");
  }

  if (Date.now() > challenge.expiresAt) {
    challenges.delete(key);
    persistNow();
    throw new Error("Challenge expired");
  }

  const recovered = ethers.verifyMessage(challenge.message, signature);
  if (toKey(recovered) !== key) {
    throw new Error("Wallet signature mismatch");
  }

  challenge.used = true;
  challenges.set(key, challenge);
  persistNow();
  return challenge;
}

module.exports = {
  buildChallenge,
  verifySignedChallenge,
};
