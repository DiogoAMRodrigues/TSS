const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Settlement", function () {
  let identity, registry, settlement, securitiesToken, cashToken;
  let deployer, buyer, seller, stranger;

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const ERC20_TYPE = ethers.encodeBytes32String("ERC20");
  const ONE_TOKEN = ethers.parseEther("1");

  // Helper for Besu tx.wait()
  async function send(txPromise) {
    const tx = await txPromise;
    await tx.wait();
    return tx;
  }

  beforeEach(async function () {
    [deployer, buyer, seller, stranger] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await send(identity.whitelist(buyer.address, TRADER_ROLE));
    await send(identity.whitelist(seller.address, TRADER_ROLE));

    const Registry = await ethers.getContractFactory("Registry");
    registry = await Registry.deploy(await identity.getAddress());
    await registry.waitForDeployment();

    const Settlement = await ethers.getContractFactory("Settlement");
    settlement = await Settlement.deploy(
      await identity.getAddress(),
      await registry.getAddress()
    );
    await settlement.waitForDeployment();

    const SecuritiesToken = await ethers.getContractFactory("SecuritiesToken");
    securitiesToken = await SecuritiesToken.deploy(
      "TestSecurity", "TSC", await identity.getAddress()
    );
    await securitiesToken.waitForDeployment();

    const CashToken = await ethers.getContractFactory("CashToken");
    cashToken = await CashToken.deploy(
      "TokenizedEUR", "tEUR", await identity.getAddress()
    );
    await cashToken.waitForDeployment();

    await send(registry.registerAsset(await securitiesToken.getAddress(), ERC20_TYPE, deployer.address));
    await send(registry.registerAsset(await cashToken.getAddress(), ERC20_TYPE, deployer.address));

    await send(securitiesToken.mint(seller.address, ONE_TOKEN));
    await send(cashToken.mint(buyer.address, ONE_TOKEN));

    await send(securitiesToken.connect(seller).approve(await settlement.getAddress(), ONE_TOKEN));
    await send(cashToken.connect(buyer).approve(await settlement.getAddress(), ONE_TOKEN));
  });

  describe("Deployment", function () {
    it("should not be paused on deployment", async function () {
      expect(await settlement.paused()).to.be.false;
    });

    it("should have correct OPERATOR constant", async function () {
      expect(await settlement.OPERATOR()).to.equal(OPERATOR_ROLE);
    });
  });

  describe("Settlement Execution", function () {
    it("should execute atomic DvP successfully", async function () {
      await send(settlement.settle(
        buyer.address, seller.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      ));

      expect(await securitiesToken.balanceOf(buyer.address)).to.equal(ONE_TOKEN);
      expect(await cashToken.balanceOf(seller.address)).to.equal(ONE_TOKEN);
      expect(await securitiesToken.balanceOf(seller.address)).to.equal(0);
      expect(await cashToken.balanceOf(buyer.address)).to.equal(0);
    });

    it("should record settlement data correctly", async function () {
      await send(settlement.settle(
        buyer.address, seller.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      ));

      const record = await settlement.getSettlement(1);
      expect(record.buyer).to.equal(buyer.address);
      expect(record.seller).to.equal(seller.address);
      expect(record.securitiesToken).to.equal(await securitiesToken.getAddress());
      expect(record.cashToken).to.equal(await cashToken.getAddress());
      expect(record.securitiesAmount).to.equal(ONE_TOKEN);
      expect(record.cashAmount).to.equal(ONE_TOKEN);
      expect(record.timestamp).to.be.gt(0);
    });

    it("should return empty record for getSettlement(0)", async function () {
      const record = await settlement.getSettlement(0);
      expect(record.buyer).to.equal(ethers.ZeroAddress);
      expect(record.seller).to.equal(ethers.ZeroAddress);
      expect(record.timestamp).to.equal(0);
    });

    it("should return empty record for non-existent settlement ID", async function () {
      const record = await settlement.getSettlement(999);
      expect(record.buyer).to.equal(ethers.ZeroAddress);
    });

    it("should increment settlement counter correctly", async function () {
      await send(settlement.settle(
        buyer.address, seller.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      ));

      await send(securitiesToken.mint(seller.address, ONE_TOKEN));
      await send(cashToken.mint(buyer.address, ONE_TOKEN));
      await send(securitiesToken.connect(seller).approve(await settlement.getAddress(), ONE_TOKEN));
      await send(cashToken.connect(buyer).approve(await settlement.getAddress(), ONE_TOKEN));

      await send(settlement.settle(
        buyer.address, seller.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      ));

      const record2 = await settlement.getSettlement(2);
      expect(record2.buyer).to.equal(buyer.address);
    });

    it("should allow settling where buyer == seller", async function () {
      await send(securitiesToken.mint(deployer.address, ONE_TOKEN));
      await send(cashToken.mint(deployer.address, ONE_TOKEN));
      await send(securitiesToken.connect(deployer).approve(await settlement.getAddress(), ONE_TOKEN));
      await send(cashToken.connect(deployer).approve(await settlement.getAddress(), ONE_TOKEN));

      await send(settlement.settle(
        deployer.address, deployer.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      ));

      expect(await securitiesToken.balanceOf(deployer.address)).to.equal(ONE_TOKEN);
      expect(await cashToken.balanceOf(deployer.address)).to.equal(ONE_TOKEN);
    });

    it("should revert entirely if second transfer fails (atomicity)", async function () {
      await send(cashToken.connect(buyer).approve(await settlement.getAddress(), 0));

      const sellerSecuritiesBefore = await securitiesToken.balanceOf(seller.address);
      const buyerCashBefore = await cashToken.balanceOf(buyer.address);

      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("CashToken: insufficient allowance");

      expect(await securitiesToken.balanceOf(seller.address)).to.equal(sellerSecuritiesBefore);
      expect(await cashToken.balanceOf(buyer.address)).to.equal(buyerCashBefore);
    });

    it("should reject settlement with non-whitelisted buyer", async function () {
      await expect(
        settlement.settle(
          stranger.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: buyer not whitelisted");
    });

    it("should reject settlement with non-whitelisted seller", async function () {
      await expect(
        settlement.settle(
          buyer.address, stranger.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: seller not whitelisted");
    });

    it("should reject settlement with revoked buyer", async function () {
      await send(identity.revoke(buyer.address));
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: buyer not whitelisted");
    });

    it("should reject settlement with revoked seller", async function () {
      await send(identity.revoke(seller.address));
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: seller not whitelisted");
    });

    it("should reject settlement with unregistered securities token", async function () {
      const UnregisteredToken = await ethers.getContractFactory("SecuritiesToken");
      const unregistered = await UnregisteredToken.deploy(
        "Unregistered", "UNR", await identity.getAddress()
      );
      await unregistered.waitForDeployment();

      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await unregistered.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: securities token not registered");
    });

    it("should reject settlement with unregistered cash token", async function () {
      const UnregisteredToken = await ethers.getContractFactory("CashToken");
      const unregistered = await UnregisteredToken.deploy(
        "Unregistered", "UNR", await identity.getAddress()
      );
      await unregistered.waitForDeployment();

      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await unregistered.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: cash token not registered");
    });

    it("should reject settlement with deactivated securities token", async function () {
      await send(registry.deactivateAsset(await securitiesToken.getAddress()));
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: securities token not registered");
    });

    it("should reject settlement with deactivated cash token", async function () {
      await send(registry.deactivateAsset(await cashToken.getAddress()));
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: cash token not registered");
    });

    it("should reject settlement with zero securities amount", async function () {
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          0, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: amounts must be > 0");
    });

    it("should reject settlement with zero cash amount", async function () {
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, 0
        )
      ).to.be.revertedWith("Settlement: amounts must be > 0");
    });

    it("should reject settlement when securities allowance insufficient", async function () {
      await send(securitiesToken.connect(seller).approve(await settlement.getAddress(), 0));
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("SecuritiesToken: insufficient allowance");
    });

    it("should reject settlement when cash allowance insufficient", async function () {
      await send(cashToken.connect(buyer).approve(await settlement.getAddress(), 0));
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("CashToken: insufficient allowance");
    });
  });

  describe("Pause", function () {
    it("should allow operator to pause", async function () {
      await send(settlement.pause());
      expect(await settlement.paused()).to.be.true;
    });

    it("should allow operator to unpause", async function () {
      await send(settlement.pause());
      await send(settlement.unpause());
      expect(await settlement.paused()).to.be.false;
    });

    it("should reject pause from non-operator", async function () {
      await expect(
        settlement.connect(stranger).pause()
      ).to.be.revertedWith("Settlement: caller is not an operator");
    });

    it("should reject unpause from non-operator", async function () {
      await send(settlement.pause());
      await expect(
        settlement.connect(stranger).unpause()
      ).to.be.revertedWith("Settlement: caller is not an operator");
    });

    it("should reject settle when paused", async function () {
      await send(settlement.pause());
      await expect(
        settlement.settle(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("Settlement: contract is paused");
    });

    it("should allow settle after unpause", async function () {
      await send(settlement.pause());
      await send(settlement.unpause());
      await send(settlement.settle(
        buyer.address, seller.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      ));
      expect(await securitiesToken.balanceOf(buyer.address)).to.equal(ONE_TOKEN);
    });
  });

  describe("Events", function () {
    it("should emit SettlementExecuted on successful settle", async function () {
      const tx = await settlement.settle(
        buyer.address, seller.address,
        await securitiesToken.getAddress(), await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await tx.wait();
      await expect(tx)
        .to.emit(settlement, "SettlementExecuted")
        .withArgs(
          buyer.address, seller.address,
          await securitiesToken.getAddress(), await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        );
    });

    it("should emit Paused on pause", async function () {
      const tx = await settlement.pause();
      await tx.wait();
      await expect(tx)
        .to.emit(settlement, "Paused")
        .withArgs(deployer.address);
    });

    it("should emit Unpaused on unpause", async function () {
      await send(settlement.pause());
      const tx = await settlement.unpause();
      await tx.wait();
      await expect(tx)
        .to.emit(settlement, "Unpaused")
        .withArgs(deployer.address);
    });
  });
});