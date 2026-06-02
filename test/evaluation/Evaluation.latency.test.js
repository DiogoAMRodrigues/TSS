/**
 * Section 5.2 - Wall-clock latency per operation.
 *
 * Gas tells us protocol cost; latency tells us user-facing performance.
 * We measure end-to-end wall-clock from "send tx" to "receipt mined" for:
 *   - submitOrderOB_resting        (no match, just rests in book)
 *   - submitOrderOB_match_settle   (matches resting -> Settlement DvP)
 *   - submitOrderAMM_swap          (atomic swap + settle)
 *
 * On the in-process Hardhat network these numbers are dominated by JS
 * overhead (~ms). They are still useful as a sanity baseline, but the
 * paper-quality numbers come from a real Besu run (2 s IBFT 2.0 block
 * period -> realistic finality).
 *
 * Output: evaluation_results/latency-results.json
 *   - per operation: samples, mean, p50, p95, min, max (milliseconds)
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const {
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

const SAMPLES = Number(process.env.LATENCY_SAMPLES || (network.name === "besu" ? 15 : 25));

function stats(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    samples: sorted.length,
    meanMs: +(sum / sorted.length).toFixed(2),
    p50Ms: +pct(50).toFixed(2),
    p95Ms: +pct(95).toFixed(2),
    minMs: +sorted[0].toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
  };
}

async function timeTx(txPromiseFactory) {
  const t0 = Date.now();
  const tx = await txPromiseFactory();
  await tx.wait();
  return Date.now() - t0;
}

describe("Evaluation §5.2 - Wall-clock latency per operation", function () {
  this.timeout(20 * 60 * 1000); // tolerant of Besu block periods

  it("collects per-operation latency samples and writes a JSON report", async function () {
    const core = await deployCore();
    const { orderBook } = await deployOrderBook(core);
    const { amm } = await deployAmm(core, 30);

    // Fund actors generously so we never run out across SAMPLES iterations.
    const big = ethers.parseEther("10000000");
    await send(core.cashToken.mint(core.buyer.address, big));
    await send(core.securitiesToken.mint(core.seller.address, big));
    await send(core.cashToken.mint(core.lp.address, big));
    await send(core.securitiesToken.mint(core.lp.address, big));

    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), big));
    await send(core.securitiesToken.connect(core.seller).approve(await core.settlement.getAddress(), big));

    // AMM: provide liquidity once (large enough that price impact stays small over SAMPLES swaps).
    await send(core.cashToken.connect(core.lp).approve(await amm.getAddress(), big));
    await send(core.securitiesToken.connect(core.lp).approve(await amm.getAddress(), big));
    await send(amm.connect(core.lp).addLiquidity(THOUSAND, THOUSAND));
    await send(core.cashToken.connect(core.buyer).approve(await core.settlement.getAddress(), big));

    const cashAddr = await core.cashToken.getAddress();
    const secAddr = await core.securitiesToken.getAddress();

    // ---- 1. OB resting (no match): place buy@1, far below any sell price ----
    const restingMs = [];
    for (let i = 0; i < SAMPLES; i++) {
      const ms = await timeTx(() =>
        orderBook.connect(core.buyer).submitOrder(cashAddr, secAddr, ONE, ONE)
      );
      restingMs.push(ms);
    }

    // ---- 2. OB matching: each sample is a "place resting buy + crossing sell" pair.
    // We measure only the matching/settling tx (the second one).
    const matchMs = [];
    for (let i = 0; i < SAMPLES; i++) {
      // Resting buy (not measured)
      await send(orderBook.connect(core.buyer).submitOrder(cashAddr, secAddr, ONE, ONE));
      // Crossing sell -> matches + settles
      const ms = await timeTx(() =>
        orderBook.connect(core.seller).submitOrder(secAddr, cashAddr, ONE, ONE)
      );
      matchMs.push(ms);
    }

    // ---- 3. AMM swap (atomic match + settle in one tx) ----
    const ammMs = [];
    for (let i = 0; i < SAMPLES; i++) {
      const quoted = await amm.getAmountOut(cashAddr, ONE);
      const ms = await timeTx(() =>
        amm.connect(core.buyer).submitOrder(cashAddr, secAddr, ONE, quoted)
      );
      ammMs.push(ms);
    }

    const results = {
      submitOrderOB_resting: stats(restingMs),
      submitOrderOB_match_settle: stats(matchMs),
      submitOrderAMM_swap: stats(ammMs),
    };

    expect(results.submitOrderOB_resting.samples).to.equal(SAMPLES);

    const out = writeJson("latency-results.json", {
      network: network.name,
      samplesPerOp: SAMPLES,
      generatedAt: new Date().toISOString(),
      note:
        network.name === "besu"
          ? "Besu IBFT 2.0 (2s block period). Numbers reflect real settle latency."
          : "In-process Hardhat. JS-overhead dominates; for paper-grade numbers run with --network besu.",
      results,
    });
    console.log("\n  Wrote latency results -> " + out);
    console.log("  Samples per op: " + SAMPLES + " on " + network.name);
    console.table(results);
  });
});
