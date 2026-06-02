/**
 * Section 5.1 - Functional validation (end-to-end + negative tests).
 *
 * This suite proves that the SAME deployment correctly handles:
 *   E2E-1: User onboarding (whitelist) -> asset issuance -> register
 *   E2E-2: Trade via OrderBook (buy + sell -> auto-match -> DvP)
 *   E2E-3: Trade via AMM (init pool -> add liquidity -> swap -> DvP)
 *   E2E-4: Engine switching at runtime (revoke OB -> authorize AMM,
 *          identical tokens, identical Settlement contract)
 *   NEG-1..7: Negative compliance / safety paths (non-whitelisted,
 *          revoked attestation, unregistered token, self-trade,
 *          paused settlement, slippage exceeded on AMM, expired attestation).
 *
 * Each scenario writes a row to functional-results.json so the aggregator
 * can build the §5.1 outcomes table.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  TRADER_ROLE,
  ONE,
  TEN,
  HUNDRED,
  THOUSAND,
  send,
  deployCore,
  deployOrderBook,
  deployAmm,
  writeJson,
} = require("./helpers");

describe("Evaluation §5.1 - Functional validation (E2E + negative)", function () {
  this.timeout(180000);

  const outcomes = [];
  function record(id, description, passed, note = "") {
    outcomes.push({ id, description, passed, note });
  }

  after(function () {
    const out = writeJson("functional-results.json", {
      generatedAt: new Date().toISOString(),
      total: outcomes.length,
      passed: outcomes.filter((o) => o.passed).length,
      outcomes,
    });
    console.log("\n  Wrote functional results -> " + out);
    console.table(outcomes);
  });

  // ---------- E2E ----------

  it("E2E-1: onboarding -> asset issuance -> registry", async function () {
    const core = await deployCore();
    expect(await core.identity.isWhitelisted(core.buyer.address)).to.equal(true);
    expect(await core.registry.isActive(await core.cashToken.getAddress())).to.equal(true);
    expect(await core.registry.isActive(await core.securitiesToken.getAddress())).to.equal(true);
    record("E2E-1", "Onboarding + asset issuance + registry registration", true);
  });

  it("E2E-2: OrderBook full path (buy + sell -> match -> DvP)", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.securitiesToken.mint(core.seller.address, ONE));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), ONE));

    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );
    await send(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    );

    const settlement = await core.settlement.getSettlement(1);
    expect(settlement.buyer).to.equal(core.buyer.address);
    expect(settlement.seller).to.equal(core.seller.address);
    expect(await core.securitiesToken.balanceOf(core.buyer.address)).to.equal(ONE);
    expect(await core.cashToken.balanceOf(core.seller.address)).to.equal(ONE);
    record("E2E-2", "OrderBook buy+sell -> match -> atomic DvP", true);
  });

  it("E2E-3: AMM full path (init -> liquidity -> swap -> DvP)", async function () {
    const core = await deployCore();
    const { amm } = await deployAmm(core, 30);

    await send(core.cashToken.mint(core.lp.address, HUNDRED));
    await send(core.securitiesToken.mint(core.lp.address, HUNDRED));
    await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
    await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
    await send(amm.connect(core.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    const quoted = await amm.getAmountOut(await core.cashToken.getAddress(), ONE);

    await send(
      amm.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE,
        quoted
      )
    );

    const settlement = await core.settlement.getSettlement(1);
    expect(settlement.buyer).to.equal(core.buyer.address);
    expect(settlement.seller).to.equal(await amm.getAddress());
    expect(await core.securitiesToken.balanceOf(core.buyer.address)).to.equal(quoted);
    record("E2E-3", "AMM initialize+liquidity+swap -> atomic DvP", true);
  });

  it("E2E-4: Engine switching - revoke OB, authorize AMM, same Settlement", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);
    const { amm } = await deployAmm(core, 0);

    // Use OrderBook first
    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.securitiesToken.mint(core.seller.address, ONE));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), ONE));
    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );
    await send(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    );
    const settle1 = await core.settlement.getSettlement(1);
    expect(settle1.buyer).to.equal(core.buyer.address);

    // Hot-swap engines: revoke OB, AMM is already authorized
    await send(core.settlement.revokeEngine(await orderBook.getAddress()));

    // OB is now blocked: a resting order alone doesn't hit Settlement, but
    // any matching counter-order will, so we drive the matching path.
    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );
    await send(core.securitiesToken.mint(core.seller.address, ONE));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), ONE));
    await expect(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    ).to.be.revertedWith("Settlement: caller is not an authorized engine");

    // AMM still works against the SAME Settlement
    await send(core.cashToken.mint(core.lp.address, HUNDRED));
    await send(core.securitiesToken.mint(core.lp.address, HUNDRED));
    await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
    await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
    await send(amm.connect(core.lp).addLiquidity(HUNDRED, HUNDRED));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    const quoted = await amm.getAmountOut(await core.cashToken.getAddress(), ONE);
    await send(
      amm.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE,
        quoted
      )
    );
    const settle2 = await core.settlement.getSettlement(2);
    expect(settle2.buyer).to.equal(core.buyer.address);
    record(
      "E2E-4",
      "Hot-swap engines at runtime - same Settlement contract serves OB then AMM",
      true
    );
  });

  // ---------- Negative tests ----------

  it("NEG-1: non-whitelisted user is rejected at order submission", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);
    const stranger = core.rest[0];
    await expect(
      orderBook.connect(stranger).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    ).to.be.revertedWith("OrderBook: caller not whitelisted");
    record("NEG-1", "Non-whitelisted user rejected at submission", true);
  });

  it("NEG-2: revoked attestation blocks subsequent matching", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );

    // Revoke the buyer AFTER the order is resting.
    await send(core.identity.revoke(core.buyer.address));

    await send(core.securitiesToken.mint(core.seller.address, ONE));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), ONE));
    // The matching loop re-checks whitelisting and skips/aborts; the seller's
    // submit succeeds but produces no match, so no settlement record exists.
    await send(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    );
    await expect(core.settlement.getSettlement(1)).to.be.revertedWith("Settlement: invalid settlement ID");
    record("NEG-2", "Revoked attestation prevents matching of resting order", true);
  });

  it("NEG-3: unregistered (deactivated) token rejected at submission", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);
    await send(core.registry.deactivateAsset(await core.cashToken.getAddress()));
    await expect(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    ).to.be.revertedWith("OrderBook: tokenIn not registered");
    record("NEG-3", "Deactivated token rejected at submission", true);
  });

  it("NEG-4: self-trade prevented (single trader on both sides)", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.securitiesToken.mint(core.buyer.address, ONE));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(core.securitiesToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));

    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );
    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    );
    // No settlement was created (self-trade was skipped).
    await expect(core.settlement.getSettlement(1)).to.be.revertedWith("Settlement: invalid settlement ID");
    record("NEG-4", "Self-trade skipped by matching loop (no settlement)", true);
  });

  it("NEG-5: paused Settlement blocks the matching tx", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.securitiesToken.mint(core.seller.address, ONE));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), ONE));

    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );
    await send(core.settlement.pause());
    await expect(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    ).to.be.revertedWith("Settlement: contract is paused");
    record("NEG-5", "Paused Settlement reverts matching tx", true);
  });

  it("NEG-6: AMM slippage protection rejects unfavourable swap", async function () {
    const core = await deployCore();
    const { amm } = await deployAmm(core, 0);

    await send(core.cashToken.mint(core.lp.address, HUNDRED));
    await send(core.securitiesToken.mint(core.lp.address, HUNDRED));
    await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
    await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
    await send(amm.connect(core.lp).addLiquidity(HUNDRED, HUNDRED));

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));

    // Demand way more output than the curve can give.
    await expect(
      amm.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE,
        HUNDRED // amountOutMin = 100, impossible
      )
    ).to.be.revertedWith("AMM: slippage exceeded");
    record("NEG-6", "AMM slippage protection (amountOutMin) honoured", true);
  });

  it("NEG-7: expired attestation prevents matching of resting order", async function () {
    // Mirrors NEG-2 but exercises the EXPIRY path instead of revocation.
    // The paper claims (§3): "stale identities cannot participate in
    // trading: if a KYC attestation expires, the address is effectively
    // excluded from all system operations until re-verified." This test
    // backs that claim end-to-end.
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);

    await send(core.cashToken.mint(core.buyer.address, TEN));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    await send(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE, ONE
      )
    );

    // Force the buyer's attestation to expire shortly, then advance time past it.
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const soon = now + 60;
    await send(core.identity.updateAttestation(core.buyer.address, soon));
    await ethers.provider.send("evm_increaseTime", [120]);
    await ethers.provider.send("evm_mine", []);

    expect(await core.identity.isExpired(core.buyer.address)).to.equal(true);
    expect(await core.identity.isWhitelisted(core.buyer.address)).to.equal(false);

    // Crossing sell from a still-valid seller: matching loop re-checks
    // whitelisting and skips the buyer's expired order, so no settlement
    // record is created.
    await send(core.securitiesToken.mint(core.seller.address, ONE));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), ONE));
    await send(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE, ONE
      )
    );
    await expect(core.settlement.getSettlement(1)).to.be.revertedWith("Settlement: invalid settlement ID");
    record("NEG-7", "Expired attestation prevents matching of resting order", true);
  });
});
