/**
 * Section 5.2 - OrderBook depth-scaling experiment (Figure 3 in the paper).
 *
 * The OrderBook matches with O(n) complexity in the number of OPEN orders
 * (it iterates _openOrderIds inside _tryMatch). The AMM has constant cost
 * regardless of "book depth" because there are no resting orders.
 *
 * Methodology:
 *   For each depth N in {0, 1, 5, 10, 20, 40}:
 *     1. Deploy a fresh stack.
 *     2. Pre-load N resting BUY orders that DO NOT match the probe order
 *        (they want to buy at a strictly lower price than the probe sells at).
 *     3. Submit the probe order and record gas. Because nothing crosses,
 *        the matching loop walks the entire book.
 *
 * We also record an AMM single-swap gas at every N as a baseline (constant).
 *
 * Output: zTESE/evaluation_results/scaling-results.json
 *
 * Note: this test only runs on the in-process Hardhat network. It needs
 * to fund many ad-hoc traders, which the Besu config does not support.
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
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
  createFundedTraders,
  writeJson,
} = require("./helpers");

describe("Evaluation §5.2 - OrderBook depth scaling vs AMM constant cost", function () {
  this.timeout(600000);

  before(function () {
    if (network.name === "besu") {
      this.skip();
    }
  });

  it("measures OB submitOrder gas vs open-orders depth, and AMM gas as baseline", async function () {
    const depths = [0, 1, 5, 10, 20, 40];
    const samples = [];

    for (const depth of depths) {
      const core = await deployCore();
      const { orderBook } = await deployOrderBook(core);
      const { amm } = await deployAmm(core, 0);

      // ---- Pre-load `depth` resting buy orders that won't match the probe ----
      // Each pre-loaded order: pay `depth_price` cash for 1 securities, where
      // depth_price is a TINY amount (10 wei) - far below the probe sell price.
      const traders = await createFundedTraders(core, depth);
      for (let i = 0; i < depth; i++) {
        const t = traders[i];
        // Each trader: mint cash, approve settlement, submit a non-crossing buy
        await send(core.cashToken.mint(t.address, ONE));
        await send(core.cashToken.connect(t).approve(await core.settlement.getAddress(), ONE));
        await send(
          orderBook.connect(t).submitOrder(
            await core.cashToken.getAddress(),
            await core.securitiesToken.getAddress(),
            10n,           // amountIn: tiny cash
            ONE            // amountOut: 1 whole security -> very low bid
          )
        );
      }

      // ---- Probe SELL order: sells 1 security for 1 cash, won't cross with any of the above ----
      await send(core.securitiesToken.mint(core.seller.address, ONE));
      await send(
        core.securitiesToken
          .connect(core.seller)
          .approve(await core.settlement.getAddress(), ONE)
      );
      const obProbeGas = await gasOf(
        orderBook.connect(core.seller).submitOrder(
          await core.securitiesToken.getAddress(),
          await core.cashToken.getAddress(),
          ONE,
          ONE
        )
      );

      // ---- AMM baseline: single swap with the same nominal trade size ----
      await send(core.cashToken.mint(core.lp.address, HUNDRED));
      await send(core.securitiesToken.mint(core.lp.address, HUNDRED));
      await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
      await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), HUNDRED));
      await send(amm.connect(core.lp).addLiquidity(HUNDRED, HUNDRED));

      await send(core.cashToken.mint(core.buyer.address, TEN));
      await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), ONE));
      const quoted = await amm.getAmountOut(await core.cashToken.getAddress(), ONE);
      const ammProbeGas = await gasOf(
        amm.connect(core.buyer).submitOrder(
          await core.cashToken.getAddress(),
          await core.securitiesToken.getAddress(),
          ONE,
          quoted
        )
      );

      samples.push({
        depth,
        orderBookSubmitGas: obProbeGas,
        ammSwapGas: ammProbeGas,
      });
      console.log(`    depth=${depth.toString().padStart(3)}  OB=${obProbeGas}  AMM=${ammProbeGas}`);
    }

    // Sanity: gas should grow monotonically with depth for OB
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].orderBookSubmitGas).to.be.gte(samples[i - 1].orderBookSubmitGas - 5000);
    }
    // AMM should be roughly constant (loose bound: < 30 % drift)
    const ammMin = Math.min(...samples.map((s) => s.ammSwapGas));
    const ammMax = Math.max(...samples.map((s) => s.ammSwapGas));
    expect(ammMax - ammMin).to.be.lessThan(ammMin * 0.3);

    const out = writeJson("scaling-results.json", {
      network: network.name,
      generatedAt: new Date().toISOString(),
      samples,
    });
    console.log("\n  Wrote scaling results -> " + out);
  });
});
