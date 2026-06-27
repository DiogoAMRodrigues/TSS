const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const VALID_ROLES = new Set(["TRADER", "ISSUER", "OPERATOR", "REGULATOR"]);

// A per-attestation random salt held only in the off-chain record. Deleting the
// off-chain record removes the salt, making the on-chain attestation hash
// unrecomputable and therefore unlinkable to the natural person (GDPR erasure).
function generateAttestationSalt() {
  return crypto.randomBytes(32).toString("hex");
}

// Per-person commitment binding the verified identity to a wallet address.
// SHA-256 over the lowercased wallet, a stable identity subject (eIDAS NIC or
// provider evidence id), and the off-chain salt. Returns a 32-byte hex string
// suitable for the on-chain bytes32 attestationHash field.
function computeAttestationHash({ walletAddress, subject, salt }) {
  const normalized = [
    String(walletAddress || "").toLowerCase(),
    String(subject || ""),
    String(salt || ""),
  ].join("|");
  return ethers.sha256(ethers.toUtf8Bytes(normalized));
}

function loadIdentityAbi() {
  const abiPath = process.env.IDENTITY_ABI_PATH
    ? path.resolve(process.cwd(), process.env.IDENTITY_ABI_PATH)
    : path.resolve(
        process.cwd(),
        "artifacts/contracts/identity/Identity.sol/Identity.json"
      );

  const content = fs.readFileSync(abiPath, "utf-8");
  return JSON.parse(content).abi;
}

function loadPrivateKey(explicitPrivateKey) {
  if (explicitPrivateKey) {
    return explicitPrivateKey;
  }

  if (process.env.OPERATOR_PRIVATE_KEY) {
    return process.env.OPERATOR_PRIVATE_KEY;
  }

  const privateKeyFile = process.env.OPERATOR_PRIVATE_KEY_FILE;
  if (privateKeyFile) {
    const value = fs.readFileSync(path.resolve(process.cwd(), privateKeyFile), "utf-8").trim();
    if (value) {
      return value;
    }
  }

  return null;
}

function assertSecurePrivateKey(privateKey) {
  if (!privateKey) {
    throw new Error("OPERATOR_PRIVATE_KEY is required");
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("OPERATOR_PRIVATE_KEY must be a 32-byte hex string");
  }

  const knownDevKeys = new Set([
    "0x1ca60577f0b6dbf9ebddeb330615c25824f2e458eed044b0abc3ac954eb1f3db",
    "0xae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f",
    "0x0dbbe8e4ae425a6d2687f1a7e3ba17bc98c673636790f1b8ad91193c05875ef1",
    "0xc88b703fb08cbea894b6aeff5a544fb92e78a18e19814cd85da83b71f772aa6c",
    "0x388c684f0ba1ef5017716adb5d21a053ea8e90277d0868337519f97bede61418",
  ]);
  const allowDevKeys = String(process.env.ALLOW_DEV_KEYS || "false").toLowerCase() === "true";
  if (process.env.NODE_ENV === "production" && knownDevKeys.has(privateKey) && !allowDevKeys) {
    throw new Error("Refusing to start with known development private key in production");
  }
}

function normalizeRole(role) {
  const value = String(role || "").toUpperCase();
  if (!VALID_ROLES.has(value)) {
    throw new Error(`Invalid role '${role}'. Use one of: ${Array.from(VALID_ROLES).join(", ")}`);
  }
  return value;
}

class IdentityClient {
  constructor(options = {}) {
    if (options.contract && options.signer && options.provider) {
      this.provider = options.provider;
      this.signer = options.signer;
      this.contract = options.contract;
      return;
    }

    const rpcUrl = options.rpcUrl || process.env.RPC_URL || "http://localhost:8545";
    const privateKey = loadPrivateKey(options.privateKey);
    const identityAddress = options.identityAddress || process.env.IDENTITY_ADDRESS;

    assertSecurePrivateKey(privateKey);
    if (!identityAddress) {
      throw new Error("IDENTITY_ADDRESS is required");
    }

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(identityAddress, loadIdentityAbi(), this.signer);
  }

  async whitelist(walletAddress, role, attestationHash = ethers.ZeroHash) {
    const normalizedRole = normalizeRole(role);
    const roleBytes32 = ethers.keccak256(ethers.toUtf8Bytes(normalizedRole));
    const tx = await this.contract.whitelist(walletAddress, roleBytes32, attestationHash);
    const receipt = await tx.wait();
    return { txHash: tx.hash, blockNumber: receipt.blockNumber, role: normalizedRole, attestationHash };
  }

  async updateAttestation(walletAddress, expiryUnixSeconds) {
    const tx = await this.contract.updateAttestation(walletAddress, expiryUnixSeconds);
    const receipt = await tx.wait();
    return { txHash: tx.hash, blockNumber: receipt.blockNumber, expiryUnixSeconds };
  }

  async revoke(walletAddress) {
    const tx = await this.contract.revoke(walletAddress);
    const receipt = await tx.wait();
    return { txHash: tx.hash, blockNumber: receipt.blockNumber };
  }

  async prefersEasyReverification(walletAddress) {
    return this.contract.prefersEasyReverification(walletAddress);
  }

  async isWhitelisted(walletAddress) {
    return this.contract.isWhitelisted(walletAddress);
  }

  async getRole(walletAddress) {
    return this.contract.getRole(walletAddress);
  }

  async isExpired(walletAddress) {
    return this.contract.isExpired(walletAddress);
  }
}

module.exports = IdentityClient;
module.exports.normalizeRole = normalizeRole;
module.exports.loadIdentityAbi = loadIdentityAbi;
module.exports.computeAttestationHash = computeAttestationHash;
module.exports.generateAttestationSalt = generateAttestationSalt;
