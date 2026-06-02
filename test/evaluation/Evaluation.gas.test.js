/**
 * Section 5.2 - Per-operation gas cost analysis (Table I in the paper).
 *
 * Measures gas usage of every interesting operation in the TSS, on a clean
 * deployment, and writes a JSON report under zTESE/evaluation_results/.
 *
 * Operations measured:
 *   - Deployments (Identity, Registry, Settlement, SecuritiesToken,
 *     CashToken, OrderBook, AMM)
 *   - Compliance ops (whitelist, registerAsset, authorizeEngine)
 *   - Token ops (mint, approve)
 *   - Trading ops (submitOrder OB, submitOrder OB matching, submitOrder AMM,
 *     addLiquidity, removeLiquidity, cancelOrder)
 *
 * Why this matters: in a permissioned setting gas is operator-controlled, but
 * relative gas usage still measures protocol cost (block-size budget, latency,
 * fairness). The OB vs AMM comparison shows that the pluggable interface does
 * NOT impose the same cost on both engines - they scale differently.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  ONE,
  TEN,
  HUNDRED,
  THOUSAND,
  send,
  gasOf,
  deployCore,
  deployOrderBook,
  deployAmm,
  writeJson,
} = require("./helpers");

describe("Evaluation §5.2 - Gas cost per operation", function () {
  this.timeout(180000);

  it("collects per-operation gas measurements and writes a JSON report", async function () {
    const core = await deployCore();
    const { orderBook, deployGas: obDeploy, authGas: obAuth } = await deployOrderBook(core);
    const { amm, deployGas: ammDeploy, authGas: ammAuth, initGas: ammInit } = await deployAmm(core, 30);

    const gas = { ...core.gas };
    gas.deployOrderBook = obDeploy;
    gas.authorizeEngineOB = obAuth;
    gas.deployAmm = ammDeploy;
    gas.authorizeEngineAMM = ammAuth;
    gas.initializeAmmPool = ammInit;

    // ---- Token ops ----
    gas.mintCashToken = await gasOf(core.cashToken.mint(core.buyer.address, THOUSAND));
    await send(core.cashToken.mint(core.lp.address, THOUSAND));
    await send(core.securitiesToken.mint(core.seller.address, THOUSAND));
    await send(core.securitiesToken.mint(core.lp.address, THOUSAND));

    gas.approveCashToken = await gasOf(
      core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), HUNDRED)
    );
    await send(
      core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), HUNDRED)
    );

    // ---- OrderBook submitOrder (no match - rests in book) ----
    gas.submitOrderOB_resting = await gasOf(
      orderBook.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE,
        ONE
      )
    );

    // ---- OrderBook submitOrder (matches the resting one -> triggers settle) ----
    gas.submitOrderOB_match_and_settle = await gasOf(
      orderBook.connect(core.seller).submitOrder(
        await core.securitiesToken.getAddress(),
        await core.cashToken.getAddress(),
        ONE,
        ONE
      )
    );

    // ---- OrderBook cancelOrder (place a new resting order, then cancel) ----
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), HUNDRED));
    const submitForCancelTx = await orderBook
      .connect(core.buyer)
      .submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE,
        ONE
      );
    const submitForCancelReceipt = await submitForCancelTx.wait();
    const submittedOrderId = (await orderBook._orderCounter?.()) ?? null;
    // We don't have a public getter for the counter; reuse the event-derived id:
    const ev = submitForCancelReceipt.logs
      .map((l) => {
        try { return orderBook.interface.parseLog(l); } catch { return null; }
      })
      .filter((p) => p && p.name === "OrderSubmitted")[0];
    const cancelOrderId = ev.args[0];
    gas.cancelOrderOB = await gasOf(orderBook.connect(core.buyer).cancelOrder(cancelOrderId));

    // ---- AMM addLiquidity (initial) ----
    await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), THOUSAND));
    await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), THOUSAND));
    gas.addLiquidityAMM_initial = await gasOf(amm.connect(core.lp).addLiquidity(HUNDRED, HUNDRED));

    // ---- AMM addLiquidity (subsequent, ratio-matched) ----
    gas.addLiquidityAMM_subsequent = await gasOf(amm.connect(core.lp).addLiquidity(TEN, TEN));

    // ---- AMM submitOrder (cash -> securities swap, settles atomically) ----
    await send(core.cashToken.mint(core.buyer.address, HUNDRED));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
    const quoted = await amm.getAmountOut(await core.cashToken.getAddress(), ONE);
    gas.submitOrderAMM_swap = await gasOf(
      amm.connect(core.buyer).submitOrder(
        await core.cashToken.getAddress(),
        await core.securitiesToken.getAddress(),
        ONE,
        quoted
      )
    );

    // ---- AMM removeLiquidity ----
    const lpShares = await amm.liquidityShares(core.lp.address);
    const halfShares = lpShares / 2n;
    gas.removeLiquidityAMM = await gasOf(amm.connect(core.lp).removeLiquidity(halfShares));

    // Sanity checks
    expect(gas.submitOrderOB_match_and_settle).to.be.greaterThan(gas.submitOrderOB_resting);
    expect(gas.submitOrderAMM_swap).to.be.greaterThan(0);

    const out = writeJson("gas-results.json", {
      network: ethers.provider._network?.name ?? "unknown",
      generatedAt: new Date().toISOString(),
      gas,
    });
    console.log("\n  Wrote gas results -> " + out);
    console.table(gas);
  });
});
