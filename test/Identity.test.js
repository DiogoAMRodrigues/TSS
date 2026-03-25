const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Identity", function () {
  let identity;
  let deployer, trader, operator2, stranger;

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ISSUER"));
  const REGULATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REGULATOR"));

  async function send(txPromise) {
    const tx = await txPromise;
    await tx.wait();
    return tx;
  }

  async function waitForExpiry() {
    if (network.name === "besu") {
      await new Promise(r => setTimeout(r, 12000));
    } else {
      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine");
    }
  }

  beforeEach(async function () {
    [deployer, trader, operator2, stranger] = await ethers.getSigners();
    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set deployer as admin", async function () {
      expect(await identity.admin()).to.equal(deployer.address);
    });

    it("should whitelist deployer as OPERATOR", async function () {
      expect(await identity.isWhitelisted(deployer.address)).to.be.true;
    });

    it("should give deployer OPERATOR role", async function () {
      expect(await identity.getRole(deployer.address)).to.equal(OPERATOR_ROLE);
    });
  });

  describe("Role Constants", function () {
    it("should have correct TRADER role constant", async function () {
      expect(await identity.TRADER()).to.equal(TRADER_ROLE);
    });

    it("should have correct OPERATOR role constant", async function () {
      expect(await identity.OPERATOR()).to.equal(OPERATOR_ROLE);
    });

    it("should have correct ISSUER role constant", async function () {
      expect(await identity.ISSUER()).to.equal(ISSUER_ROLE);
    });

    it("should have correct REGULATOR role constant", async function () {
      expect(await identity.REGULATOR()).to.equal(REGULATOR_ROLE);
    });
  });

  describe("Whitelisting", function () {
    it("should allow operator to whitelist a TRADER", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      expect(await identity.isWhitelisted(trader.address)).to.be.true;
      expect(await identity.getRole(trader.address)).to.equal(TRADER_ROLE);
    });

    it("should allow operator to whitelist an ISSUER", async function () {
      await send(identity.whitelist(trader.address, ISSUER_ROLE));
      expect(await identity.getRole(trader.address)).to.equal(ISSUER_ROLE);
      expect(await identity.isWhitelisted(trader.address)).to.be.true;
    });

    it("should allow operator to whitelist a REGULATOR", async function () {
      await send(identity.whitelist(trader.address, REGULATOR_ROLE));
      expect(await identity.getRole(trader.address)).to.equal(REGULATOR_ROLE);
      expect(await identity.isWhitelisted(trader.address)).to.be.true;
    });

    it("should allow operator to whitelist another OPERATOR", async function () {
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      expect(await identity.getRole(operator2.address)).to.equal(OPERATOR_ROLE);
      expect(await identity.isWhitelisted(operator2.address)).to.be.true;
    });

    it("should allow a newly whitelisted OPERATOR to whitelist others", async function () {
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      await send(identity.connect(operator2).whitelist(trader.address, TRADER_ROLE));
      expect(await identity.isWhitelisted(trader.address)).to.be.true;
    });

    it("should overwrite role when whitelisting same address twice", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      await send(identity.whitelist(trader.address, ISSUER_ROLE));
      expect(await identity.getRole(trader.address)).to.equal(ISSUER_ROLE);
      expect(await identity.isWhitelisted(trader.address)).to.be.true;
    });

    it("should return zero bytes32 for getRole on non-whitelisted address", async function () {
      expect(await identity.getRole(stranger.address)).to.equal(ethers.ZeroHash);
    });

    it("should reject whitelisting from non-operator", async function () {
      await expect(
        identity.connect(stranger).whitelist(trader.address, TRADER_ROLE)
      ).to.be.revertedWith("Identity: caller is not an operator");
    });

    it("should reject zero address", async function () {
      await expect(
        identity.whitelist(ethers.ZeroAddress, TRADER_ROLE)
      ).to.be.revertedWith("Identity: zero address");
    });

    it("should reject invalid role", async function () {
      const INVALID_ROLE = ethers.keccak256(ethers.toUtf8Bytes("INVALID"));
      await expect(
        identity.whitelist(trader.address, INVALID_ROLE)
      ).to.be.revertedWith("Identity: invalid role");
    });
  });

  describe("Revocation", function () {
    it("should allow operator to revoke a user", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      await send(identity.revoke(trader.address));
      expect(await identity.isWhitelisted(trader.address)).to.be.false;
    });

    it("should not allow revoked user to be treated as whitelisted", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      await send(identity.revoke(trader.address));
      expect(await identity.isWhitelisted(trader.address)).to.be.false;
    });

    it("should not allow revoked OPERATOR to whitelist others", async function () {
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      await send(identity.revoke(operator2.address));
      await expect(
        identity.connect(operator2).whitelist(trader.address, TRADER_ROLE)
      ).to.be.revertedWith("Identity: caller is not an operator");
    });

    it("should reject revocation from non-operator", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      await expect(
        identity.connect(stranger).revoke(trader.address)
      ).to.be.revertedWith("Identity: caller is not an operator");
    });

    it("should reject revoking an inactive user", async function () {
      await expect(
        identity.revoke(stranger.address)
      ).to.be.revertedWith("Identity: user not active");
    });
  });

  describe("Attestation", function () {
    it("should allow operator to update attestation expiry", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      const newExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 * 2;
      await send(identity.updateAttestation(trader.address, newExpiry));
      expect(await identity.isExpired(trader.address)).to.be.false;
    });

    it("should reject updating attestation for inactive user", async function () {
      const newExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
      await expect(
        identity.updateAttestation(stranger.address, newExpiry)
      ).to.be.revertedWith("Identity: user not active");
    });

    it("should reject expiry in the past", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      const pastExpiry = Math.floor(Date.now() / 1000) - 1000;
      await expect(
        identity.updateAttestation(trader.address, pastExpiry)
      ).to.be.revertedWith("Identity: expiry must be in future");
    });

    it("should reject updating attestation from non-operator", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      const newExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
      await expect(
        identity.connect(stranger).updateAttestation(trader.address, newExpiry)
      ).to.be.revertedWith("Identity: caller is not an operator");
    });

    it("should return isExpired true for non-whitelisted address", async function () {
      expect(await identity.isExpired(stranger.address)).to.be.true;
    });

    it("should never expire for deployer with max uint256 expiry", async function () {
      expect(await identity.isWhitelisted(deployer.address)).to.be.true;
      expect(await identity.isExpired(deployer.address)).to.be.false;
    });
  });

  describe("Expiry Behavior", function () {
    it("should mark user as not whitelisted after expiry", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));

      const block = await ethers.provider.getBlock("latest");
      const nearExpiry = block.timestamp + 10;
      await send(identity.updateAttestation(trader.address, nearExpiry));

      await waitForExpiry();

      expect(await identity.isWhitelisted(trader.address)).to.be.false;
      expect(await identity.isExpired(trader.address)).to.be.true;
    });

    it("should allow re-whitelisting after expiry", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));

      const block = await ethers.provider.getBlock("latest");
      const nearExpiry = block.timestamp + 10;
      await send(identity.updateAttestation(trader.address, nearExpiry));

      await waitForExpiry();

      expect(await identity.isWhitelisted(trader.address)).to.be.false;

      await send(identity.whitelist(trader.address, TRADER_ROLE));
      expect(await identity.isWhitelisted(trader.address)).to.be.true;
    });
  });

  describe("Events", function () {
    it("should emit UserWhitelisted on whitelist", async function () {
      const tx = await identity.whitelist(trader.address, TRADER_ROLE);
      await tx.wait();
      await expect(tx)
        .to.emit(identity, "UserWhitelisted")
        .withArgs(trader.address, TRADER_ROLE);
    });

    it("should emit UserRevoked on revoke", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      const tx = await identity.revoke(trader.address);
      await tx.wait();
      await expect(tx)
        .to.emit(identity, "UserRevoked")
        .withArgs(trader.address);
    });

    it("should emit AttestationUpdated on updateAttestation", async function () {
      await send(identity.whitelist(trader.address, TRADER_ROLE));
      const newExpiry = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 * 2;
      const tx = await identity.updateAttestation(trader.address, newExpiry);
      await tx.wait();
      await expect(tx)
        .to.emit(identity, "AttestationUpdated")
        .withArgs(trader.address, newExpiry);
    });
  });
});