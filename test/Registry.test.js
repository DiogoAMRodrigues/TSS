const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Registry", function () {
  let identity, registry;
  let deployer, issuer, stranger, addr1, addr2;

  const ISSUER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ISSUER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const ERC20_TYPE = ethers.encodeBytes32String("ERC20");
  const ERC1155_TYPE = ethers.encodeBytes32String("ERC1155");

  beforeEach(async function () {
    [deployer, issuer, stranger, addr1, addr2] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await identity.whitelist(issuer.address, ISSUER_ROLE);

    const Registry = await ethers.getContractFactory("Registry");
    registry = await Registry.deploy(await identity.getAddress());
    await registry.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should have correct OPERATOR role constant", async function () {
      expect(await registry.OPERATOR()).to.equal(OPERATOR_ROLE);
    });
  });

  describe("Asset Registration", function () {
    it("should allow operator to register an asset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      expect(await registry.isRegistered(addr1.address)).to.be.true;
      expect(await registry.isActive(addr1.address)).to.be.true;
    });

    it("should store correct asset data", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      const asset = await registry.getAsset(addr1.address);
      expect(asset.tokenAddress).to.equal(addr1.address);
      expect(asset.assetType).to.equal(ERC20_TYPE);
      expect(asset.issuer).to.equal(issuer.address);
      expect(asset.active).to.be.true;
      expect(asset.registeredAt).to.be.gt(0);
    });

    it("should support different asset types", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.registerAsset(addr2.address, ERC1155_TYPE, issuer.address);
      expect((await registry.getAsset(addr1.address)).assetType).to.equal(ERC20_TYPE);
      expect((await registry.getAsset(addr2.address)).assetType).to.equal(ERC1155_TYPE);
    });

    it("should allow registering asset with zero address issuer", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, ethers.ZeroAddress);
      expect(await registry.isRegistered(addr1.address)).to.be.true;
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
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await expect(
        registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address)
      ).to.be.revertedWith("Registry: asset already registered");
    });

    it("should add asset to getAllAssets list", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      const assets = await registry.getAllAssets();
      expect(assets).to.include(addr1.address);
    });

    it("should track multiple registered assets", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.registerAsset(addr2.address, ERC20_TYPE, issuer.address);
      const assets = await registry.getAllAssets();
      expect(assets.length).to.equal(2);
      expect(assets).to.include(addr1.address);
      expect(assets).to.include(addr2.address);
    });
  });

  describe("Asset Deactivation", function () {
    it("should allow operator to deactivate an asset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      expect(await registry.isActive(addr1.address)).to.be.false;
      expect(await registry.isRegistered(addr1.address)).to.be.true;
    });

    it("should keep asset in getAllAssets after deactivation", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      const assets = await registry.getAllAssets();
      expect(assets).to.include(addr1.address);
    });

    it("should reject deactivation from non-operator", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await expect(
        registry.connect(stranger).deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject deactivating an already inactive asset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      await expect(
        registry.deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: asset not active");
    });

    it("should reject deactivating an unregistered asset", async function () {
      await expect(
        registry.deactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: asset not active");
    });
  });

  describe("Asset Reactivation", function () {
    it("should allow operator to reactivate a deactivated asset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      await registry.reactivateAsset(addr1.address);
      expect(await registry.isActive(addr1.address)).to.be.true;
    });

    it("should reject reactivation from non-operator", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      await expect(
        registry.connect(stranger).reactivateAsset(addr1.address)
      ).to.be.revertedWith("Registry: caller is not an operator");
    });

    it("should reject reactivating an already active asset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
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
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      await registry.reactivateAsset(addr1.address);
      await registry.deactivateAsset(addr1.address);
      await registry.reactivateAsset(addr1.address);
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
      await expect(registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address))
        .to.emit(registry, "AssetRegistered")
        .withArgs(addr1.address, ERC20_TYPE, issuer.address);
    });

    it("should emit AssetDeactivated on deactivateAsset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await expect(registry.deactivateAsset(addr1.address))
        .to.emit(registry, "AssetDeactivated")
        .withArgs(addr1.address);
    });

    it("should emit AssetReactivated on reactivateAsset", async function () {
      await registry.registerAsset(addr1.address, ERC20_TYPE, issuer.address);
      await registry.deactivateAsset(addr1.address);
      await expect(registry.reactivateAsset(addr1.address))
        .to.emit(registry, "AssetReactivated")
        .withArgs(addr1.address);
    });
  });
});