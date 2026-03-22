const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OrderBook", function () {
  let identity, registry, settlement, orderBook, securitiesToken, cashToken;
  let deployer, buyer, seller, stranger;

  const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
  const ERC20_TYPE = ethers.encodeBytes32String("ERC20");
  const ONE_TOKEN = ethers.parseEther("1");
  const TWO_TOKENS = ethers.parseEther("2");

  beforeEach(async function () {
    [deployer, buyer, seller, stranger] = await ethers.getSigners();

    const Identity = await ethers.getContractFactory("Identity");
    identity = await Identity.deploy();
    await identity.waitForDeployment();

    await identity.whitelist(buyer.address, TRADER_ROLE);
    await identity.whitelist(seller.address, TRADER_ROLE);

    const Registry = await ethers.getContractFactory("Registry");
    registry = await Registry.deploy(await identity.getAddress());
    await registry.waitForDeployment();

    const Settlement = await ethers.getContractFactory("Settlement");
    settlement = await Settlement.deploy(
      await identity.getAddress(),
      await registry.getAddress()
    );
    await settlement.waitForDeployment();

    const OrderBook = await ethers.getContractFactory("OrderBook");
    orderBook = await OrderBook.deploy(
      await identity.getAddress(),
      await registry.getAddress(),
      await settlement.getAddress()
    );
    await orderBook.waitForDeployment();

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

    await registry.registerAsset(await securitiesToken.getAddress(), ERC20_TYPE, deployer.address);
    await registry.registerAsset(await cashToken.getAddress(), ERC20_TYPE, deployer.address);

    await securitiesToken.mint(seller.address, ONE_TOKEN);
    await cashToken.mint(buyer.address, ONE_TOKEN);

    await securitiesToken.connect(seller).approve(await settlement.getAddress(), ONE_TOKEN);
    await cashToken.connect(buyer).approve(await settlement.getAddress(), ONE_TOKEN);
  });

  describe("Deployment", function () {
    it("should have correct OPERATOR constant", async function () {
      expect(await orderBook.OPERATOR()).to.equal(OPERATOR_ROLE);
    });
  });

  describe("Order Submission", function () {
    it("should allow whitelisted trader to submit order", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      const order = await orderBook.getOrder(1);
      expect(order.trader).to.equal(buyer.address);
      expect(order.status).to.equal(0); // OPEN
    });

    it("should allow operator to submit order", async function () {
      await cashToken.mint(deployer.address, ONE_TOKEN);
      await orderBook.connect(deployer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      const order = await orderBook.getOrder(1);
      expect(order.trader).to.equal(deployer.address);
    });

    it("should return empty order for getOrder(0)", async function () {
      const order = await orderBook.getOrder(0);
      expect(order.trader).to.equal(ethers.ZeroAddress);
      expect(order.orderId).to.equal(0);
    });

    it("should return empty order for non-existent order ID", async function () {
      const order = await orderBook.getOrder(999);
      expect(order.trader).to.equal(ethers.ZeroAddress);
    });

    it("should return empty getMatch for id 0", async function () {
      const match = await orderBook.getMatch(0);
      expect(match.buyer).to.equal(ethers.ZeroAddress);
      expect(match.matchId).to.equal(0);
    });

    it("should return empty getMatch for non-existent match id", async function () {
      const match = await orderBook.getMatch(999);
      expect(match.buyer).to.equal(ethers.ZeroAddress);
    });

    it("should return empty getPendingMatches initially", async function () {
      const pending = await orderBook.getPendingMatches();
      expect(pending.length).to.equal(0);
    });

    it("should reject order from non-whitelisted address", async function () {
      await expect(
        orderBook.connect(stranger).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("OrderBook: caller not whitelisted");
    });

    it("should reject order where tokenIn == tokenOut", async function () {
      await expect(
        orderBook.connect(buyer).submitOrder(
          await cashToken.getAddress(),
          await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("OrderBook: tokenIn and tokenOut must differ");
    });

    it("should reject order with unregistered tokenIn", async function () {
      const UnregisteredToken = await ethers.getContractFactory("CashToken");
      const unregistered = await UnregisteredToken.deploy(
        "Unregistered", "UNR", await identity.getAddress()
      );
      await unregistered.waitForDeployment();

      await expect(
        orderBook.connect(buyer).submitOrder(
          await unregistered.getAddress(),
          await securitiesToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("OrderBook: tokenIn not registered");
    });

    it("should reject order with unregistered tokenOut", async function () {
      const UnregisteredToken = await ethers.getContractFactory("SecuritiesToken");
      const unregistered = await UnregisteredToken.deploy(
        "Unregistered", "UNR", await identity.getAddress()
      );
      await unregistered.waitForDeployment();

      await expect(
        orderBook.connect(buyer).submitOrder(
          await cashToken.getAddress(),
          await unregistered.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("OrderBook: tokenOut not registered");
    });

    it("should reject order with deactivated tokenIn", async function () {
      await registry.deactivateAsset(await cashToken.getAddress());
      await expect(
        orderBook.connect(buyer).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("OrderBook: tokenIn not registered");
    });

    it("should reject order with zero amountIn", async function () {
      await expect(
        orderBook.connect(buyer).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          0, ONE_TOKEN
        )
      ).to.be.revertedWith("OrderBook: amounts must be > 0");
    });

    it("should reject order with zero amountOut", async function () {
      await expect(
        orderBook.connect(buyer).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE_TOKEN, 0
        )
      ).to.be.revertedWith("OrderBook: amounts must be > 0");
    });

    it("should correctly store order data", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      const order = await orderBook.getOrder(1);
      expect(order.orderId).to.equal(1);
      expect(order.trader).to.equal(buyer.address);
      expect(order.tokenIn).to.equal(await cashToken.getAddress());
      expect(order.tokenOut).to.equal(await securitiesToken.getAddress());
      expect(order.amountIn).to.equal(ONE_TOKEN);
      expect(order.amountOut).to.equal(ONE_TOKEN);
      expect(order.status).to.equal(0); // OPEN
      // LOCAL ONLY: timestamp check uses block time which is deterministic in Hardhat.
      // On Besu, timestamp will be real wall clock time - just verify it is non-zero.
      expect(order.timestamp).to.be.gt(0);
    });

    it("should increment order IDs correctly", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(buyer).cancelOrder(1);

      await cashToken.mint(buyer.address, ONE_TOKEN);
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      const order2 = await orderBook.getOrder(2);
      expect(order2.orderId).to.equal(2);
    });
  });

  describe("Order Cancellation", function () {
    it("should allow trader to cancel their own order", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(buyer).cancelOrder(1);
      const order = await orderBook.getOrder(1);
      expect(order.status).to.equal(2); // CANCELLED
    });

    it("should allow operator to cancel any order", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(deployer).cancelOrder(1);
      const order = await orderBook.getOrder(1);
      expect(order.status).to.equal(2); // CANCELLED
    });

    it("should reject cancellation from non-owner non-operator", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await expect(
        orderBook.connect(seller).cancelOrder(1)
      ).to.be.revertedWith("OrderBook: not authorized");
    });

    it("should reject cancellation from stranger", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await expect(
        orderBook.connect(stranger).cancelOrder(1)
      ).to.be.revertedWith("OrderBook: not authorized");
    });

    it("should reject cancelling an already cancelled order", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(buyer).cancelOrder(1);
      await expect(
        orderBook.connect(buyer).cancelOrder(1)
      ).to.be.revertedWith("OrderBook: order not open");
    });

    it("should reject cancelling a matched order", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await expect(
        orderBook.connect(buyer).cancelOrder(1)
      ).to.be.revertedWith("OrderBook: order not open");
    });
  });

  describe("Order Matching and Settlement", function () {
    it("should match compatible orders and execute DvP", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      expect(await securitiesToken.balanceOf(buyer.address)).to.equal(ONE_TOKEN);
      expect(await cashToken.balanceOf(seller.address)).to.equal(ONE_TOKEN);
      expect(await securitiesToken.balanceOf(seller.address)).to.equal(0);
      expect(await cashToken.balanceOf(buyer.address)).to.equal(0);
    });

    it("should mark both orders as MATCHED after settlement", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      expect((await orderBook.getOrder(1)).status).to.equal(1); // MATCHED
      expect((await orderBook.getOrder(2)).status).to.equal(1); // MATCHED
    });

    it("should store match data correctly", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      const match = await orderBook.getMatch(1);
      expect(match.matchId).to.equal(1);
      // order1 is seller's order (triggered the match), order2 is buyer's original order
      expect(match.buyer).to.equal(seller.address);
      expect(match.seller).to.equal(buyer.address);
    });

    it("should not match orders with incompatible tokens", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      await cashToken.mint(seller.address, ONE_TOKEN);
      await cashToken.connect(seller).approve(await settlement.getAddress(), ONE_TOKEN);

      await orderBook.connect(seller).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      expect((await orderBook.getOrder(1)).status).to.equal(0); // OPEN
      expect((await orderBook.getOrder(2)).status).to.equal(0); // OPEN
    });

    it("should not match a cancelled order", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(buyer).cancelOrder(1);

      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      expect((await orderBook.getOrder(1)).status).to.equal(2); // CANCELLED
      expect((await orderBook.getOrder(2)).status).to.equal(0); // OPEN, no match
    });

    it("should handle multiple sequential matches correctly", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      await securitiesToken.mint(seller.address, ONE_TOKEN);
      await cashToken.mint(buyer.address, ONE_TOKEN);
      await securitiesToken.connect(seller).approve(await settlement.getAddress(), ONE_TOKEN);
      await cashToken.connect(buyer).approve(await settlement.getAddress(), ONE_TOKEN);

      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      expect((await orderBook.getOrder(3)).status).to.equal(1); // MATCHED
      expect((await orderBook.getOrder(4)).status).to.equal(1); // MATCHED
    });

    it("should not match orders where prices do not cross", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, TWO_TOKENS
      );

      await orderBook.connect(seller).submitOrder(
        await securitiesToken.getAddress(),
        await cashToken.getAddress(),
        ONE_TOKEN, TWO_TOKENS
      );

      expect((await orderBook.getOrder(1)).status).to.equal(0); // OPEN
      expect((await orderBook.getOrder(2)).status).to.equal(0); // OPEN
    });

    it("should revert match if seller has insufficient balance", async function () {
      await securitiesToken.burn(seller.address, ONE_TOKEN);

      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );

      await expect(
        orderBook.connect(seller).submitOrder(
          await securitiesToken.getAddress(),
          await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.be.revertedWith("SecuritiesToken: insufficient balance");
    });
  });

  describe("Events", function () {
    it("should emit OrderSubmitted on submitOrder", async function () {
      await expect(
        orderBook.connect(buyer).submitOrder(
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      )
        .to.emit(orderBook, "OrderSubmitted")
        .withArgs(
          1, buyer.address,
          await cashToken.getAddress(),
          await securitiesToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        );
    });

    it("should emit OrderCancelled on cancelOrder", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await expect(orderBook.connect(buyer).cancelOrder(1))
        .to.emit(orderBook, "OrderCancelled")
        .withArgs(1, buyer.address);
    });

    it("should emit OrderMatched when orders match", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await expect(
        orderBook.connect(seller).submitOrder(
          await securitiesToken.getAddress(),
          await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.emit(orderBook, "OrderMatched");
    });

    it("should emit SettlementExecuted when orders match", async function () {
      await orderBook.connect(buyer).submitOrder(
        await cashToken.getAddress(),
        await securitiesToken.getAddress(),
        ONE_TOKEN, ONE_TOKEN
      );
      await expect(
        orderBook.connect(seller).submitOrder(
          await securitiesToken.getAddress(),
          await cashToken.getAddress(),
          ONE_TOKEN, ONE_TOKEN
        )
      ).to.emit(settlement, "SettlementExecuted");
    });
  });
});