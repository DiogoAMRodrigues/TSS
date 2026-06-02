/**
 * Section 5.2 - AMM price-impact / slippage curve.
 *
 * Justifies the §2.1 paper claim that AMMs incur slippage proportional to
 * trade size relative to pool depth, on OUR system. For each trade size
 * S in {0.1%, 1%, 5%, 10%, 25%} of pool cash reserves we:
 *   1. Deploy a fresh AMM pool with R = 1,000,000 cash and 1,000,000 securities.
 *   2. Quote getAmountOut(cash -> sec, S * R).
 *   3. Compute realised price = amountIn / amountOut (cash per sec).
 *   4. Compare to spot price (= 1.0 for symmetric pool) -> slippage %.
 *
 * Fee is 30 bps (default). The reported slippage thus combines fee + curve
 * impact, which is what a user actually pays.
 *
 * Output: evaluation_results/slippage-results.json
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { send, deployCore, deployAmm, writeJson } = require("./helpers");

// Use a large pool so percentage math is precise without overflow worries.
const POOL_RESERVE = ethers.parseEther("1000000"); // 1M cash, 1M sec
const SIZES_PCT = [0.1, 1, 5, 10, 25];

describe("Evaluation §5.2 - AMM slippage curve", function () {
  this.timeout(10 * 60 * 1000);

  it("measures realised slippage at varying trade sizes and writes a JSON report", async function () {
    const samples = [];

    for (const pct of SIZES_PCT) {
      // Fresh stack per size so each measurement is on a pristine pool.
      const core = await deployCore();
      const { amm } = await deployAmm(core, 30);

      const cashAddr = await core.cashToken.getAddress();
      const secAddr = await core.securitiesToken.getAddress();

      const big = POOL_RESERVE * 10n;
      await send(core.cashToken.mint(core.lp.address, big));
      await send(core.securitiesToken.mint(core.lp.address, big));
      await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), big));
      await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), big));
      await send(amm.connect(core.lp).addLiquidity(POOL_RESERVE, POOL_RESERVE));

      // Compute trade size in wei. Use BigInt math: (reserve * pctNumerator) / pctDenominator.
      // Treat pct with 4-decimal precision: 0.1% -> 10/10000.
      const num = BigInt(Math.round(pct * 100));
      const den = 10000n;
      const amountIn = (POOL_RESERVE * num) / den;

      const amountOut = await amm.getAmountOut(cashAddr, amountIn);

      // Spot price (cash per sec) for symmetric pool = 1.
      // Realised price = amountIn / amountOut (cash per sec received).
      // Slippage = (realised / spot) - 1 = (amountIn / amountOut) - 1.
      // Use 1e18 fixed-point for precision.
      const SCALE = 10n ** 18n;
      const realisedPriceScaled = (amountIn * SCALE) / amountOut; // (cash/sec) * 1e18
      const spotPriceScaled = SCALE; // 1 * 1e18 (symmetric pool)
      const slippageScaled =
        ((realisedPriceScaled - spotPriceScaled) * 10000n) / spotPriceScaled; // bps
      const slippageBps = Number(slippageScaled);
      const slippagePct = slippageBps / 100;

      samples.push({
        sizePctOfPool: pct,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        spotPrice: 1.0,
        realisedPrice: Number(realisedPriceScaled) / 1e18,
        slippageBps,
        slippagePct: +slippagePct.toFixed(4),
      });
    }

    // Sanity: slippage must be monotonically non-decreasing in trade size.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].slippageBps).to.be.greaterThanOrEqual(samples[i - 1].slippageBps);
    }

    const out = writeJson("slippage-results.json", {
      network: network.name,
      generatedAt: new Date().toISOString(),
      poolReserveCash: POOL_RESERVE.toString(),
      poolReserveSecurities: POOL_RESERVE.toString(),
      feeBps: 30,
      samples,
    });
    console.log("\n  Wrote slippage results -> " + out);
    console.table(
      samples.map((s) => ({
        sizePctOfPool: s.sizePctOfPool,
        realisedPrice: s.realisedPrice.toFixed(6),
        slippagePct: s.slippagePct,
      }))
    );
  });
});
