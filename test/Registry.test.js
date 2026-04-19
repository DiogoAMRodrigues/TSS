// Registry.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Registry", function () {
  let identity, registry;
  let deployer, issuer, operator2, stranger, addr1;

  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ISSUER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const ERC20_TYPE = ethers.encodeBytes32String("ERC20");
  const ERC1155_TYPE = ethers.encodeBytes32String("ERC1155");
  const CASH_TOKEN_TYPE = ethers.encodeBytes32String("CASH_TOKEN");
  const SECURITIES_TYPE = ethers.encodeBytes32String("SECURITIES");

  async function send(txPromise) {
    const tx = await txPromise;
    await tx.wait();
    return tx;
  }

  async function latestTs() {
    const block = await ethers.provider.getBlock("latest");
    return Number(block.timestamp);
  }

  async function waitForExpiry(targetExpiry) {
    if (network.name === "besu") {
      for (let i = 0; i < 30; i++) {
        if ((await latestTs()) > targetExpiry) return;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error("Timed out waiting for expiry on Besu");
    } else {
      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine");
    }
  }

  beforeEach(async function () {
    [deployer, issuer, operator2, stranger, addr1] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await send(identity.whitelist(issuer.address, ISSUER_ROLE));

    const Registry = await ethers.getContractFactory("Registry");
    registry = await Registry.deploy(await identity.getAddress());
    await registry.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should have correct OPERATOR role constant", async function () {
      expect(await registry.OPERATOR()).to.equal(OPERATOR_ROLE);
    });

    it("should reject deployment with zero identity address", async function () {
      const Registry = await ethers.getContractFactory("Registry");
      await expect(
        Registry.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("Registry: zero identity address");
    });
  });

  describe("Asset Registration", function () {
    it("should allow operator to register an asset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      expect(await registry.isRegistered(addr1.address)).to.be.true;
      expect(await registry.isActive(addr1.address)).to.be.true;
    });

    it("should store correct asset data", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      const asset = await registry.getAsset(addr1.address);
      expect(asset.tokenAddress).to.equal(addr1.address);
      expect(asset.assetType).to.equal(ERC20_TYPE);
      expect(asset.issuer).to.equal(issuer.address);
      expect(asset.active).to.be.true;
      expect(asset.registeredAt).to.be.gt(0);
    });

    it("should support different asset types", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.registerAsset(operator2.address, ERC1155_TYPE, issuer.address));
      expect((await registry.getAsset(addr1.address)).assetType).to.equal(ERC20_TYPE);
      expect((await registry.getAsset(operator2.address)).assetType).to.equal(ERC1155_TYPE);
    });

    it("should distinguish cash token type from securities type", async function () {
      await send(registry.registerAsset(addr1.address, CASH_TOKEN_TYPE, issuer.address));
      await send(registry.registerAsset(operator2.address, SECURITIES_TYPE, issuer.address));
      expect((await registry.getAsset(addr1.address)).assetType).to.equal(CASH_TOKEN_TYPE);
      expect((await registry.getAsset(operator2.address)).assetType).to.equal(SECURITIES_TYPE);
      expect((await registry.getAsset(addr1.address)).assetType).to.not.equal(SECURITIES_TYPE);
      expect((await registry.getAsset(operator2.address)).assetType).to.not.equal(CASH_TOKEN_TYPE);
    });

    it("should reject registering asset with zero address issuer", async function () {
      await expect(
        registry.registerAsset(addr1.address, ERC20_TYPE, ethers.ZeroAddress)
      ).to.be.revertedWith("Registry: zero issuer address");
    });

    it("should reject registration from non-operator", async function () {
      await expect(
        registry.connect(stranger).registerAsset(addr1.address, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject registration from ISSUER role", async function () {
      await expect(
        registry.connect(issuer).registerAsset(addr1.address, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject zero address token", async function () {
      await expect(
        registry.registerAsset(ethers.ZeroAddress, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: zero address");
    });

    it("should reject registering same asset twice", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await expect(
        registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: asset already registered");
    });

    it("should add asset to getAllAssets list", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      const assets = await registry.getAllAssets();
      expect(assets).to.include(addr1.address);
    });

    it("should track multiple registered assets", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.registerAsset(operator2.address, ERC20_TYPE, issuer.address));
      const assets = await registry.getAllAssets();
      expect(assets.length).to.equal(2);
      expect(assets).to.include(addr1.address);
      expect(assets).to.include(operator2.address);
    });

    it("should reject registration from revoked operator", async function () {
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      await send(identity.revoke(operator2.address));
      await expect(
        registry.connect(operator2).registerAsset(addr1.address, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject registration from expired operator", async function () {
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      const block = await ethers.provider.getBlock("latest");
      const nearExpiry = block.timestamp + 10;
      await send(identity.updateAttestation(operator2.address, nearExpiry));
      await waitForExpiry(nearExpiry);
      await expect(
        registry.connect(operator2).registerAsset(addr1.address, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });
  });

  describe("Asset Deactivation", function () {
    it("should allow operator to deactivate an asset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      expect(await registry.isActive(addr1.address)).to.be.false;
      expect(await registry.isRegistered(addr1.address)).to.be.true;
    });

    it("should keep asset in getAllAssets after deactivation", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      const assets = await registry.getAllAssets();
      expect(assets).to.include(addr1.address);
    });

    it("should reject deactivation from non-operator", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await expect(
        registry.connect(stranger).deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject deactivating an already inactive asset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      await expect(
        registry.deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: asset not active");
    });

    it("should reject deactivating an unregistered asset", async function () {
      await expect(
        registry.deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: asset not active");
    });

    it("should reject deactivation from revoked operator", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      await send(identity.revoke(operator2.address));
      await expect(
        registry.connect(operator2).deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject deactivation from expired operator", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(identity.whitelist(operator2.address, OPERATOR_ROLE));
      const block = await ethers.provider.getBlock("latest");
      const nearExpiry = block.timestamp + 10;
      await send(identity.updateAttestation(operator2.address, nearExpiry));
      await waitForExpiry(nearExpiry);
      await expect(
        registry.connect(operator2).deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });
  });

  describe("Asset Reactivation", function () {
    it("should allow operator to reactivate a deactivated asset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      await send(registry.reactivateAsset(addr1.address));
      expect(await registry.isActive(addr1.address)).to.be.true;
    });

    it("should reject reactivation from non-operator", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      await expect(
        registry.connect(stranger).reactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject reactivating an already active asset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await expect(
        registry.reactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: asset already active");
    });

    it("should reject reactivating an unregistered asset", async function () {
      await expect(
        registry.reactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: asset not registered");
    });

    it("should allow deactivate and reactivate cycle multiple times", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      await send(registry.reactivateAsset(addr1.address));
      await send(registry.deactivateAsset(addr1.address));
      await send(registry.reactivateAsset(addr1.address));
      expect(await registry.isActive(addr1.address)).to.be.true;
    });
  });

  describe("Queries", function () {
    it("should return false for isRegistered on unknown asset", async function () {
      expect(await registry.isRegistered(stranger.address)).to.be.false;
    });

    it("should return false for isActive on unknown asset", async function () {
      expect(await registry.isActive(stranger.address)).to.be.false;
    });

    it("should return empty array for getAllAssets when none registered", async function () {
      const assets = await registry.getAllAssets();
      expect(assets.length).to.equal(0);
    });

    it("should return zero values for getAsset on unknown asset", async function () {
      const asset = await registry.getAsset(stranger.address);
      expect(asset.tokenAddress).to.equal(ethers.ZeroAddress);
      expect(asset.active).to.be.false;
      expect(asset.registeredAt).to.equal(0);
    });
  });

  describe("Events", function () {
    it("should emit AssetRegistered on registerAsset", async function () {
      const tx = await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await tx.wait();
      await expect(tx)
        .to.emit(registry, "AssetRegistered")
        .withArgs(addr1.address, ERC20_TYPE, issuer.address);
    });

    it("should emit AssetDeactivated on deactivateAsset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      const tx = await registry.deactivateAsset(addr1.address);
      await tx.wait();
      await expect(tx)
        .to.emit(registry, "AssetDeactivated")
        .withArgs(addr1.address);
    });

    it("should emit AssetReactivated on reactivateAsset", async function () {
      await send(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address));
      await send(registry.deactivateAsset(addr1.address));
      const tx = await registry.reactivateAsset(addr1.address);
      await tx.wait();
      await expect(tx)
        .to.emit(registry, "AssetReactivated")
        .withArgs(addr1.address);
    });
  });
});