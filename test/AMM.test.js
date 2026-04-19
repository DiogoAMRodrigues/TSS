const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AMM", function () {
  let identity, registry, settlement, amm, securitiesToken, cashToken;
  let deployer, lp, trader, seller, stranger;

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const CASH_TOKEN_TYPE = ethers.encodeBytes32String("CASH_TOKEN");
  const SECURITIES_TYPE = ethers.encodeBytes32String("SECURITIES");

  const ONE = ethers.parseEther("1");
  const TEN = ethers.parseEther("10");
  const FIFTY = ethers.parseEther("50");
  const HUNDRED = ethers.parseEther("100");

  const FEE_BPS = 30;

  async function send(txPromise) {
    const tx = await txPromise;
    await tx.wait();
    return tx;
  }

  function getAmountOut(amountIn, reserveIn, reserveOut, feeBps = FEE_BPS) {
    const BPS = 10000n;
    const amountInWithFee = amountIn * (BPS - BigInt(feeBps));
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * BPS + amountInWithFee;
    return numerator / denominator;
  }

  async function deployAmm() {
    const AMM = await ethers.getContractFactory("AMM");
    amm = await AMM.deploy(
      await identity.getAddress(),
      await registry.getAddress(),
      await settlement.getAddress(),
      FEE_BPS
    );
    await amm.waitForDeployment();
  }

  async function bootstrapPool() {
    await send(identity.whitelist(await amm.getAddress(), TRADER_ROLE));
    await send(settlement.authorizeEngine(await amm.getAddress()));
    if (!(await amm.poolInitialized())) {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
    }

    await send(cashToken.mint(lp.address, HUNDRED));
    await send(securitiesToken.mint(lp.address, HUNDRED));

    await send(cashToken.connect(lp).approve(await amm.getAddress(), HUNDRED));
    await send(securitiesToken.connect(lp).approve(await amm.getAddress(), HUNDRED));

    await send(amm.connect(lp).addLiquidity(HUNDRED, HUNDRED));
  }

  beforeEach(async function () {
    [deployer, lp, trader, seller, stranger] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await send(identity.whitelist(lp.address, TRADER_ROLE));
    await send(identity.whitelist(trader.address, TRADER_ROLE));
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

    await deployAmm();

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

    await send(registry.registerAsset(await cashToken.getAddress(), CASH_TOKEN_TYPE, deployer.address));
    await send(registry.registerAsset(await securitiesToken.getAddress(), SECURITIES_TYPE, deployer.address));
  });

  describe("Deployment", function () {
    it("should expose OPERATOR constant", async function () {
      expect(await amm.OPERATOR()).to.equal(OPERATOR_ROLE);
    });

    it("should store fee and start unpaused", async function () {
      expect(await amm.feeBps()).to.equal(FEE_BPS);
      expect(await amm.paused()).to.equal(false);
      expect(await amm.poolInitialized()).to.equal(false);
    });

    it("should reject zero identity address", async function () {
      const AMM = await ethers.getContractFactory("AMM");
      await expect(
        AMM.deploy(ethers.ZeroAddress, await registry.getAddress(), await settlement.getAddress(), FEE_BPS)
      ).to.be.revertedWith("AMM: zero identity address");
    });

    it("should reject zero registry address", async function () {
      const AMM = await ethers.getContractFactory("AMM");
      await expect(
        AMM.deploy(await identity.getAddress(), ethers.ZeroAddress, await settlement.getAddress(), FEE_BPS)
      ).to.be.revertedWith("AMM: zero registry address");
    });

    it("should reject zero settlement address", async function () {
      const AMM = await ethers.getContractFactory("AMM");
      await expect(
        AMM.deploy(await identity.getAddress(), await registry.getAddress(), ethers.ZeroAddress, FEE_BPS)
      ).to.be.revertedWith("AMM: zero settlement address");
    });

    it("should reject invalid fee", async function () {
      const AMM = await ethers.getContractFactory("AMM");
      await expect(
        AMM.deploy(await identity.getAddress(), await registry.getAddress(), await settlement.getAddress(), 10000)
      ).to.be.revertedWith("AMM: invalid fee");
    });
  });

  describe("Pool Initialization", function () {
    it("should allow operator to initialize with valid token types", async function () {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
      expect(await amm.poolInitialized()).to.equal(true);
      expect(await amm.cashToken()).to.equal(await cashToken.getAddress());
      expect(await amm.securitiesToken()).to.equal(await securitiesToken.getAddress());
    });

    it("should emit PoolInitialized", async function () {
      await expect(
        amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress())
      )
        .to.emit(amm, "PoolInitialized")
        .withArgs(await cashToken.getAddress(), await securitiesToken.getAddress(), FEE_BPS);
    });

    it("should reject non-operator initializer", async function () {
      await expect(
        amm.connect(stranger).initializePool(await cashToken.getAddress(), await securitiesToken.getAddress())
      ).to.be.revertedWith("AMM: caller is not an operator");
    });

    it("should reject initializing with wrong cash token type", async function () {
      await expect(
        amm.initializePool(await securitiesToken.getAddress(), await cashToken.getAddress())
      ).to.be.revertedWith("AMM: invalid cash token type");
    });

    it("should reject zero token addresses", async function () {
      await expect(
        amm.initializePool(ethers.ZeroAddress, await securitiesToken.getAddress())
      ).to.be.revertedWith("AMM: zero token address");
    });

    it("should reject identical token addresses", async function () {
      await expect(
        amm.initializePool(await cashToken.getAddress(), await cashToken.getAddress())
      ).to.be.revertedWith("AMM: identical token addresses");
    });

    it("should reject initialization when securities token is inactive", async function () {
      await send(registry.deactivateAsset(await securitiesToken.getAddress()));
      await expect(
        amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress())
      ).to.be.revertedWith("AMM: securities token not registered");
    });

    it("should reject double initialization", async function () {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
      await expect(
        amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress())
      ).to.be.revertedWith("AMM: pool already initialized");
    });
  });

  describe("Liquidity", function () {
    beforeEach(async function () {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
    });

    it("should add initial liquidity and mint shares", async function () {
      await send(cashToken.mint(lp.address, HUNDRED));
      await send(securitiesToken.mint(lp.address, HUNDRED));
      await send(cashToken.connect(lp).approve(await amm.getAddress(), HUNDRED));
      await send(securitiesToken.connect(lp).approve(await amm.getAddress(), HUNDRED));

      await send(identity.whitelist(await amm.getAddress(), TRADER_ROLE));
      await send(amm.connect(lp).addLiquidity(HUNDRED, HUNDRED));

      expect(await amm.reserveCash()).to.equal(HUNDRED);
      expect(await amm.reserveSecurities()).to.equal(HUNDRED);
      expect(await amm.totalLiquidityShares()).to.equal(HUNDRED);
      expect(await amm.liquidityShares(lp.address)).to.equal(HUNDRED);
    });

    it("should emit LiquidityAdded on addLiquidity", async function () {
      await send(cashToken.mint(lp.address, TEN));
      await send(securitiesToken.mint(lp.address, TEN));
      await send(cashToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(securitiesToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(identity.whitelist(await amm.getAddress(), TRADER_ROLE));

      await expect(amm.connect(lp).addLiquidity(TEN, TEN))
        .to.emit(amm, "LiquidityAdded")
        .withArgs(lp.address, TEN, TEN, TEN);
    });

    it("should reject adding zero amounts", async function () {
      await send(cashToken.mint(lp.address, TEN));
      await send(securitiesToken.mint(lp.address, TEN));
      await send(cashToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(securitiesToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(identity.whitelist(await amm.getAddress(), TRADER_ROLE));

      await expect(
        amm.connect(lp).addLiquidity(0, TEN)
      ).to.be.revertedWith("AMM: amounts must be > 0");
    });

    it("should reject addLiquidity from revoked user", async function () {
      await send(cashToken.mint(lp.address, TEN));
      await send(securitiesToken.mint(lp.address, TEN));
      await send(cashToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(securitiesToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(identity.whitelist(await amm.getAddress(), TRADER_ROLE));
      await send(identity.revoke(lp.address));

      await expect(
        amm.connect(lp).addLiquidity(TEN, TEN)
      ).to.be.revertedWith("AMM: caller not whitelisted");
    });

    it("should reject adding liquidity before pool address is whitelisted", async function () {
      await send(cashToken.mint(lp.address, TEN));
      await send(securitiesToken.mint(lp.address, TEN));
      await send(cashToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(securitiesToken.connect(lp).approve(await amm.getAddress(), TEN));

      await expect(
        amm.connect(lp).addLiquidity(TEN, TEN)
      ).to.be.revertedWith("CashToken: recipient not whitelisted");
    });

    it("should reject non-proportional liquidity after initialization", async function () {
      await bootstrapPool();
      await send(cashToken.mint(lp.address, TEN));
      await send(securitiesToken.mint(lp.address, FIFTY));
      await send(cashToken.connect(lp).approve(await amm.getAddress(), TEN));
      await send(securitiesToken.connect(lp).approve(await amm.getAddress(), FIFTY));

      await expect(
        amm.connect(lp).addLiquidity(TEN, FIFTY)
      ).to.be.revertedWith("AMM: invalid liquidity ratio");
    });

    it("should remove liquidity pro-rata", async function () {
      await bootstrapPool();

      await send(amm.connect(lp).removeLiquidity(FIFTY));

      expect(await amm.reserveCash()).to.equal(FIFTY);
      expect(await amm.reserveSecurities()).to.equal(FIFTY);
      expect(await amm.totalLiquidityShares()).to.equal(FIFTY);
      expect(await amm.liquidityShares(lp.address)).to.equal(FIFTY);
    });

    it("should reject remove with insufficient shares", async function () {
      await bootstrapPool();
      await expect(
        amm.connect(trader).removeLiquidity(ONE)
      ).to.be.revertedWith("AMM: insufficient shares");
    });

    it("should reject removeLiquidity with zero shares", async function () {
      await bootstrapPool();
      await expect(
        amm.connect(lp).removeLiquidity(0)
      ).to.be.revertedWith("AMM: shares must be > 0");
    });

    it("should reject removeLiquidity from revoked user", async function () {
      await bootstrapPool();
      await send(identity.revoke(lp.address));
      await expect(
        amm.connect(lp).removeLiquidity(ONE)
      ).to.be.revertedWith("AMM: caller not whitelisted");
    });

    it("should emit LiquidityRemoved on removeLiquidity", async function () {
      await bootstrapPool();
      await expect(amm.connect(lp).removeLiquidity(FIFTY))
        .to.emit(amm, "LiquidityRemoved")
        .withArgs(lp.address, FIFTY, FIFTY, FIFTY);
    });
  });

  describe("Quote Function", function () {
    it("should reject getAmountOut before initialization", async function () {
      await expect(
        amm.getAmountOut(await cashToken.getAddress(), ONE)
      ).to.be.revertedWith("AMM: pool not initialized");
    });

    it("should reject getAmountOut with zero amountIn", async function () {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
      await expect(
        amm.getAmountOut(await cashToken.getAddress(), 0)
      ).to.be.revertedWith("AMM: amountIn must be > 0");
    });

    it("should reject getAmountOut for unsupported tokenIn", async function () {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
      await expect(
        amm.getAmountOut(stranger.address, ONE)
      ).to.be.revertedWith("AMM: unsupported tokenIn");
    });

    it("should reject getAmountOut when reserves are empty", async function () {
      await send(amm.initializePool(await cashToken.getAddress(), await securitiesToken.getAddress()));
      await expect(
        amm.getAmountOut(await cashToken.getAddress(), ONE)
      ).to.be.revertedWith("AMM: empty reserves");
    });
  });

  describe("Swaps", function () {
    beforeEach(async function () {
      await bootstrapPool();

      await send(cashToken.mint(trader.address, TEN));
      await send(securitiesToken.mint(seller.address, TEN));

      await send(cashToken.connect(trader).approve(await settlement.getAddress(), TEN));
      await send(securitiesToken.connect(seller).approve(await settlement.getAddress(), TEN));
    });

    it("should execute cash->securities swap through settlement", async function () {
      const reserveCashBefore = await amm.reserveCash();
      const reserveSecBefore = await amm.reserveSecurities();
      const amountIn = ONE;
      const expectedOut = getAmountOut(amountIn, reserveCashBefore, reserveSecBefore);

      const traderCashBefore = await cashToken.balanceOf(trader.address);
      const traderSecBefore = await securitiesToken.balanceOf(trader.address);

      await send(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          amountIn,
          expectedOut
        )
      );

      expect(await cashToken.balanceOf(trader.address)).to.equal(traderCashBefore - amountIn);
      expect(await securitiesToken.balanceOf(trader.address)).to.equal(traderSecBefore + expectedOut);
      expect(await amm.reserveCash()).to.equal(reserveCashBefore + amountIn);
      expect(await amm.reserveSecurities()).to.equal(reserveSecBefore - expectedOut);

      const order = await amm.getOrder(1);
      expect(order.status).to.equal(1);
      expect(order.amountOut).to.equal(expectedOut);
      const match = await amm.getMatch(1);
      expect(match.buyer).to.equal(trader.address);
      expect(match.buyOrderId).to.equal(1);
      expect(match.sellOrderId).to.equal(0);
    });

    it("should execute securities->cash swap through settlement", async function () {
      const reserveCashBefore = await amm.reserveCash();
      const reserveSecBefore = await amm.reserveSecurities();
      const amountIn = ONE;
      const expectedOut = getAmountOut(amountIn, reserveSecBefore, reserveCashBefore);

      const sellerCashBefore = await cashToken.balanceOf(seller.address);
      const sellerSecBefore = await securitiesToken.balanceOf(seller.address);

      await send(
        amm.connect(seller).submitOrder(
          await securitiesToken.getAddress(),
          await cashToken.getAddress(),
          amountIn,
          expectedOut
        )
      );

      expect(await cashToken.balanceOf(seller.address)).to.equal(sellerCashBefore + expectedOut);
      expect(await securitiesToken.balanceOf(seller.address)).to.equal(sellerSecBefore - amountIn);
      expect(await amm.reserveSecurities()).to.equal(reserveSecBefore + amountIn);
      expect(await amm.reserveCash()).to.equal(reserveCashBefore - expectedOut);

      const match = await amm.getMatch(1);
      expect(match.seller).to.equal(seller.address);
      expect(match.buyOrderId).to.equal(0);
      expect(match.sellOrderId).to.equal(1);
    });

    it("should record settlement data from AMM swap", async function () {
      const reserveCashBefore = await amm.reserveCash();
      const reserveSecBefore = await amm.reserveSecurities();
      const amountOut = getAmountOut(ONE, reserveCashBefore, reserveSecBefore);

      await send(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          amountOut
        )
      );

      const settlementRecord = await settlement.getSettlement(1);
      expect(settlementRecord.buyer).to.equal(trader.address);
      expect(settlementRecord.seller).to.equal(await amm.getAddress());
      expect(settlementRecord.securitiesToken).to.equal(await securitiesToken.getAddress());
      expect(settlementRecord.cashToken).to.equal(await cashToken.getAddress());
      expect(settlementRecord.securitiesAmount).to.equal(amountOut);
      expect(settlementRecord.cashAmount).to.equal(ONE);
    });

    it("should increase k after swap due to fee", async function () {
      const reserveCashBefore = await amm.reserveCash();
      const reserveSecBefore = await amm.reserveSecurities();
      const kBefore = reserveCashBefore * reserveSecBefore;

      await send(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      );

      const reserveCashAfter = await amm.reserveCash();
      const reserveSecAfter = await amm.reserveSecurities();
      const kAfter = reserveCashAfter * reserveSecAfter;

      expect(kAfter).to.be.gte(kBefore);
    });

    it("should reject swap from non-whitelisted address", async function () {
      await send(identity.revoke(trader.address));

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("AMM: caller not whitelisted");
    });

    it("should reject unsupported token pair", async function () {
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await cashToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("AMM: tokenIn and tokenOut must differ");
    });

    it("should reject swap when pool is not whitelisted", async function () {
      await send(identity.revoke(await amm.getAddress()));

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("AMM: pool not whitelisted");
    });

    it("should reject swap with amountIn zero", async function () {
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          0,
          1
        )
      ).to.be.revertedWith("AMM: amounts must be > 0");
    });

    it("should reject swap with amountOutMin zero", async function () {
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          0
        )
      ).to.be.revertedWith("AMM: amounts must be > 0");
    });

    it("should reject swap with tokenIn not active", async function () {
      await send(registry.deactivateAsset(await cashToken.getAddress()));

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("AMM: tokenIn not registered");
    });

    it("should reject swap with tokenOut not active", async function () {
      await send(registry.deactivateAsset(await securitiesToken.getAddress()));

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("AMM: tokenOut not registered");
    });

    it("should reject swap when quoted output rounds to zero", async function () {
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          1,
          1
        )
      ).to.be.revertedWith("AMM: zero output");
    });

    it("should reject when slippage tolerance is too strict", async function () {
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          ONE
        )
      ).to.be.revertedWith("AMM: slippage exceeded");
    });

    it("should reject swap when engine is not authorized", async function () {
      await send(settlement.revokeEngine(await amm.getAddress()));

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("Settlement: caller is not an authorized engine");
    });

    it("should reject swap without trader approval for settlement", async function () {
      await send(cashToken.connect(trader).approve(await settlement.getAddress(), 0));

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("CashToken: insufficient allowance");
    });

    it("should emit OrderSubmitted and OrderMatched on swap", async function () {
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      )
        .to.emit(amm, "OrderSubmitted")
        .and.to.emit(amm, "OrderMatched");
    });
  });

  describe("Cancellation and Queries", function () {
    beforeEach(async function () {
      await bootstrapPool();
      await send(cashToken.mint(trader.address, TEN));
      await send(cashToken.connect(trader).approve(await settlement.getAddress(), TEN));
      await send(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      );
    });

    it("should return empty order for getOrder(0)", async function () {
      const order = await amm.getOrder(0);
      expect(order.orderId).to.equal(0);
      expect(order.trader).to.equal(ethers.ZeroAddress);
    });

    it("should return empty order for unknown order id", async function () {
      const order = await amm.getOrder(999);
      expect(order.orderId).to.equal(0);
      expect(order.trader).to.equal(ethers.ZeroAddress);
    });

    it("should return empty match for getMatch(0)", async function () {
      const match = await amm.getMatch(0);
      expect(match.matchId).to.equal(0);
      expect(match.buyer).to.equal(ethers.ZeroAddress);
    });

    it("should return empty match for unknown match id", async function () {
      const match = await amm.getMatch(999);
      expect(match.matchId).to.equal(0);
      expect(match.buyer).to.equal(ethers.ZeroAddress);
    });

    it("should reject cancel for non-existent order", async function () {
      await expect(
        amm.connect(trader).cancelOrder(999)
      ).to.be.revertedWith("AMM: order does not exist");
    });

    it("should reject cancel from non-owner non-operator", async function () {
      await expect(
        amm.connect(stranger).cancelOrder(1)
      ).to.be.revertedWith("AMM: not authorized");
    });

    it("should reject cancel when order is already matched", async function () {
      await expect(
        amm.connect(trader).cancelOrder(1)
      ).to.be.revertedWith("AMM: order not open");
    });

    it("should reject operator cancel when order is already matched", async function () {
      await expect(
        amm.connect(deployer).cancelOrder(1)
      ).to.be.revertedWith("AMM: order not open");
    });
  });

  describe("Pause and events", function () {
    beforeEach(async function () {
      await bootstrapPool();
      await send(cashToken.mint(trader.address, TEN));
      await send(cashToken.connect(trader).approve(await settlement.getAddress(), TEN));
    });

    it("should allow operator to pause and unpause", async function () {
      await send(amm.pause());
      expect(await amm.paused()).to.equal(true);
      await send(amm.unpause());
      expect(await amm.paused()).to.equal(false);
    });

    it("should reject pause from non-operator", async function () {
      await expect(
        amm.connect(stranger).pause()
      ).to.be.revertedWith("AMM: caller is not an operator");
    });

    it("should reject unpause from non-operator", async function () {
      await send(amm.pause());
      await expect(
        amm.connect(stranger).unpause()
      ).to.be.revertedWith("AMM: caller is not an operator");
    });

    it("should block addLiquidity and submitOrder when paused", async function () {
      await send(amm.pause());

      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          1
        )
      ).to.be.revertedWith("AMM: contract is paused");

      await expect(
        amm.connect(lp).addLiquidity(ONE, ONE)
      ).to.be.revertedWith("AMM: contract is paused");
    });

    it("should emit SwapExecuted on successful swap", async function () {
      const amountOutMin = 1;
      await expect(
        amm.connect(trader).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE,
          amountOutMin
        )
      ).to.emit(amm, "SwapExecuted");
    });

    it("should return empty pending matches", async function () {
      const pending = await amm.getPendingMatches();
      expect(pending.length).to.equal(0);
    });

    it("should emit Paused and Unpaused events", async function () {
      await expect(amm.pause())
        .to.emit(amm, "Paused")
        .withArgs(deployer.address);
      await expect(amm.unpause())
        .to.emit(amm, "Unpaused")
        .withArgs(deployer.address);
    });
  });
});
