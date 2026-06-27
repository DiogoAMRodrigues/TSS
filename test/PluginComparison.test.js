const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Plugin Comparison (OrderBook vs AMM)", function () {
  this.timeout(180000);

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const CASH_TOKEN_TYPE = ethers.encodeBytes32String("CASH_TOKEN");
  const SECURITIES_TYPE = ethers.encodeBytes32String("SECURITIES");

  const ONE = ethers.parseEther("1");
  const TEN = ethers.parseEther("10");
  const HUNDRED = ethers.parseEther("100");

  async function send(txPromise) {
    const tx = await txPromise;
    await tx.wait();
    if (network.name === "besu") {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return tx;
  }

  async function deployCommon() {
    const [deployer, buyer, seller, lp] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    const identity = await Identity.deploy();
    await identity.waitForDeployment();

    await send(identity.whitelist(buyer.address, TRADER_ROLE, ethers.ZeroHash));
    await send(identity.whitelist(seller.address, TRADER_ROLE, ethers.ZeroHash));
    await send(identity.whitelist(lp.address, TRADER_ROLE, ethers.ZeroHash));

    const Registry = await ethers.getContractFactory("Registry");
    const registry = await Registry.deploy(await identity.getAddress());
    await registry.waitForDeployment();

    const Settlement = await ethers.getContractFactory("Settlement");
    const settlement = await Settlement.deploy(
      await identity.getAddress(),
      await registry.getAddress()
    );
    await settlement.waitForDeployment();

    const SecuritiesToken = await ethers.getContractFactory("SecuritiesToken");
    const securitiesToken = await SecuritiesToken.deploy(
      "TestSecurity",
      "TSC",
      await identity.getAddress()
    );
    await securitiesToken.waitForDeployment();

    const CashToken = await ethers.getContractFactory("CashToken");
    const cashToken = await CashToken.deploy(
      "TokenizedEUR",
      "tEUR",
      await identity.getAddress()
    );
    await cashToken.waitForDeployment();

    await send(registry.registerAsset(await cashToken.getAddress(), CASH_TOKEN_TYPE, deployer.address));
    await send(registry.registerAsset(await securitiesToken.getAddress(), SECURITIES_TYPE, deployer.address));

    return { deployer, buyer, seller, lp, identity, registry, settlement, cashToken, securitiesToken };
  }

  async function deployOrderBookSystem() {
    const base = await deployCommon();

    const OrderBook = await ethers.getContractFactory("OrderBook");
    const orderBook = await OrderBook.deploy(
      await base.identity.getAddress(),
      await base.registry.getAddress(),
      await base.settlement.getAddress()
    );
    await orderBook.waitForDeployment();

    await send(base.settlement.authorizeEngine(await orderBook.getAddress()));

    return { ...base, engine: orderBook };
  }

  async function deployAmmSystem() {
    const base = await deployCommon();

    const AMM = await ethers.getContractFactory("AMM");
    const amm = await AMM.deploy(
      await base.identity.getAddress(),
      await base.registry.getAddress(),
      await base.settlement.getAddress(),
      0
    );
    await amm.waitForDeployment();

    await send(base.identity.whitelist(await amm.getAddress(), TRADER_ROLE, ethers.ZeroHash));
    await send(base.settlement.authorizeEngine(await amm.getAddress()));
    await send(amm.initializePool(await base.cashToken.getAddress(), await base.securitiesToken.getAddress()));

    return { ...base, engine: amm };
  }

  it("should produce equivalent successful settlement outcomes for an equivalent buy scenario", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), ONE));

    const quotedSecurities = await amm.engine.getAmountOut(await amm.cashToken.getAddress(), ONE);

    const ammCashBefore = await amm.cashToken.balanceOf(amm.buyer.address);
    const ammSecBefore = await amm.securitiesToken.balanceOf(amm.buyer.address);

    await send(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        quotedSecurities
      )
    );

    const ammRecord = await amm.settlement.getSettlement(1);
    const ammCashAfter = await amm.cashToken.balanceOf(amm.buyer.address);
    const ammSecAfter = await amm.securitiesToken.balanceOf(amm.buyer.address);

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.securitiesToken.mint(ob.seller.address, quotedSecurities));
    await send(ob.cashToken.connect(ob.buyer).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.securitiesToken.connect(ob.seller).approve(await ob.settlement.getAddress(), quotedSecurities));

    await send(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        quotedSecurities
      )
    );

    await send(
      ob.engine.connect(ob.seller).submitOrder(
        await ob.securitiesToken.getAddress(),
        await ob.cashToken.getAddress(),
        quotedSecurities,
        ONE
      )
    );

    const obRecord = await ob.settlement.getSettlement(1);

    const obCashBefore = TEN;
    const obSecBefore = 0n;
    const obCashAfter = await ob.cashToken.balanceOf(ob.buyer.address);
    const obSecAfter = await ob.securitiesToken.balanceOf(ob.buyer.address);

    expect(ammRecord.buyer).to.equal(amm.buyer.address);
    expect(obRecord.buyer).to.equal(ob.buyer.address);
    expect(ammRecord.cashAmount).to.equal(obRecord.cashAmount);
    expect(ammRecord.securitiesAmount).to.equal(obRecord.securitiesAmount);

    const ammCashDelta = ammCashBefore - ammCashAfter;
    const ammSecDelta = ammSecAfter - ammSecBefore;
    const obCashDelta = obCashBefore - obCashAfter;
    const obSecDelta = obSecAfter - obSecBefore;

    expect(ammCashDelta).to.equal(obCashDelta);
    expect(ammSecDelta).to.equal(obSecDelta);
  });

  it("should fail similarly when engine authorization is revoked", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), ONE));
    await send(amm.settlement.revokeEngine(await amm.engine.getAddress()));

    await expect(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        1
      )
    ).to.be.revertedWith("Settlement: caller is not an authorized engine");

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.securitiesToken.mint(ob.seller.address, ONE));
    await send(ob.cashToken.connect(ob.buyer).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.securitiesToken.connect(ob.seller).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.settlement.revokeEngine(await ob.engine.getAddress()));

    await send(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    );

    await expect(
      ob.engine.connect(ob.seller).submitOrder(
        await ob.securitiesToken.getAddress(),
        await ob.cashToken.getAddress(),
        ONE,
        ONE
      )
    ).to.be.revertedWith("Settlement: caller is not an authorized engine");
  });

  it("should fail similarly when buyer cash allowance is missing", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), 0));

    await expect(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        1
      )
    ).to.be.revertedWith("CashToken: insufficient allowance");

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.securitiesToken.mint(ob.seller.address, ONE));
    await send(ob.cashToken.connect(ob.buyer).approve(await ob.settlement.getAddress(), 0));
    await send(ob.securitiesToken.connect(ob.seller).approve(await ob.settlement.getAddress(), ONE));

    await send(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    );

    await expect(
      ob.engine.connect(ob.seller).submitOrder(
        await ob.securitiesToken.getAddress(),
        await ob.cashToken.getAddress(),
        ONE,
        ONE
      )
    ).to.be.revertedWith("CashToken: insufficient allowance");
  });

  it("should fail similarly when buyer is not whitelisted", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(amm.identity.revoke(amm.buyer.address));
    await expect(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        1
      )
    ).to.be.revertedWith("AMM: caller not whitelisted");

    await send(ob.identity.revoke(ob.buyer.address));
    await expect(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    ).to.be.revertedWith("OrderBook: caller not whitelisted");
  });

  it("should fail similarly when traded token is deactivated in registry", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), ONE));
    await send(amm.registry.deactivateAsset(await amm.cashToken.getAddress()));

    await expect(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        1
      )
    ).to.be.revertedWith("AMM: tokenIn not registered");

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.registry.deactivateAsset(await ob.cashToken.getAddress()));

    await expect(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    ).to.be.revertedWith("OrderBook: tokenIn not registered");
  });

  it("should fail similarly when settlement is paused", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), ONE));
    await send(amm.settlement.pause());

    await expect(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        1
      )
    ).to.be.revertedWith("Settlement: contract is paused");

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.securitiesToken.mint(ob.seller.address, ONE));
    await send(ob.cashToken.connect(ob.buyer).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.securitiesToken.connect(ob.seller).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.settlement.pause());

    await send(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    );

    await expect(
      ob.engine.connect(ob.seller).submitOrder(
        await ob.securitiesToken.getAddress(),
        await ob.cashToken.getAddress(),
        ONE,
        ONE
      )
    ).to.be.revertedWith("Settlement: contract is paused");
  });

  it("should show different transaction counts to reach settlement", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));
    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), ONE));

    await send(
      amm.engine.connect(amm.buyer).submitOrder(
        await amm.cashToken.getAddress(),
        await amm.securitiesToken.getAddress(),
        ONE,
        1
      )
    );

    const ammSettlement = await amm.settlement.getSettlement(1);
    expect(ammSettlement.buyer).to.equal(amm.buyer.address);

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.securitiesToken.mint(ob.seller.address, ONE));
    await send(ob.cashToken.connect(ob.buyer).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.securitiesToken.connect(ob.seller).approve(await ob.settlement.getAddress(), ONE));

    await send(
      ob.engine.connect(ob.buyer).submitOrder(
        await ob.cashToken.getAddress(),
        await ob.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    );

    await expect(ob.settlement.getSettlement(1)).to.be.revertedWith("Settlement: invalid settlement ID");

    await send(
      ob.engine.connect(ob.seller).submitOrder(
        await ob.securitiesToken.getAddress(),
        await ob.cashToken.getAddress(),
        ONE,
        ONE
      )
    );

    const obSettlement = await ob.settlement.getSettlement(1);
    expect(obSettlement.buyer).to.equal(ob.buyer.address);
  });

  it("should provide gas evidence for equivalent successful settlement paths", async function () {
    const ob = await deployOrderBookSystem();
    const amm = await deployAmmSystem();

    await send(amm.cashToken.mint(amm.lp.address, HUNDRED));
    await send(amm.securitiesToken.mint(amm.lp.address, HUNDRED));
    await send(amm.cashToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.securitiesToken.connect(amm.lp).approve(await amm.engine.getAddress(), HUNDRED));
    await send(amm.engine.connect(amm.lp).addLiquidity(HUNDRED, HUNDRED));
    await send(amm.cashToken.mint(amm.buyer.address, TEN));
    await send(amm.cashToken.connect(amm.buyer).approve(await amm.settlement.getAddress(), ONE));

    const ammTx = await amm.engine.connect(amm.buyer).submitOrder(
      await amm.cashToken.getAddress(),
      await amm.securitiesToken.getAddress(),
      ONE,
      1
    );
    const ammReceipt = await ammTx.wait();
    const ammGas = ammReceipt.gasUsed;

    await send(ob.cashToken.mint(ob.buyer.address, TEN));
    await send(ob.securitiesToken.mint(ob.seller.address, ONE));
    await send(ob.cashToken.connect(ob.buyer).approve(await ob.settlement.getAddress(), ONE));
    await send(ob.securitiesToken.connect(ob.seller).approve(await ob.settlement.getAddress(), ONE));

    const obTx1 = await ob.engine.connect(ob.buyer).submitOrder(
      await ob.cashToken.getAddress(),
      await ob.securitiesToken.getAddress(),
      ONE,
      ONE
    );
    const obReceipt1 = await obTx1.wait();

    const obTx2 = await ob.engine.connect(ob.seller).submitOrder(
      await ob.securitiesToken.getAddress(),
      await ob.cashToken.getAddress(),
      ONE,
      ONE
    );
    const obReceipt2 = await obTx2.wait();

    const obGasTotal = obReceipt1.gasUsed + obReceipt2.gasUsed;

    expect(ammGas).to.be.gt(0n);
    expect(obGasTotal).to.be.gt(0n);
    expect(ammGas).to.not.equal(obGasTotal);
  });
});
