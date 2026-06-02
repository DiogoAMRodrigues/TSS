/**
 * Shared helpers for the Evaluation test suites (Section 5 of the paper / thesis).
 *
 * These helpers deploy a clean instance of the full TSS stack and provide
 * utilities used by:
 *   - Evaluation.gas.test.js        (Section 5.2 - per-operation gas table)
 *   - Evaluation.scaling.test.js    (Section 5.2 - OrderBook O(n) depth scaling)
 *   - Evaluation.functional.test.js (Section 5.1 - end-to-end + negative tests)
 *
 * Results are appended to JSON files under zTESE/evaluation_results/ and
 * later aggregated by scripts/run-evaluation.js into LaTeX-ready output.
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR"));
const CASH_TOKEN_TYPE = ethers.encodeBytes32String("CASH_TOKEN");
const SECURITIES_TYPE = ethers.encodeBytes32String("SECURITIES");

const ONE = ethers.parseEther("1");
const TEN = ethers.parseEther("10");
const HUNDRED = ethers.parseEther("100");
const THOUSAND = ethers.parseEther("1000");
const MILLION = ethers.parseEther("1000000");

const RESULTS_DIR = path.resolve(__dirname, "..", "..", "zTESE", "evaluation_results");

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

/**
 * On Besu, IBFT 2.0 has a 2 s block period. A short pause after every tx
 * keeps nonces tidy under back-to-back submissions.
 */
async function send(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (network.name === "besu") {
    await new Promise((r) => setTimeout(r, 75));
  }
  return { tx, receipt };
}

/**
 * Capture gas used for a single transaction.
 */
async function gasOf(txPromise) {
  const { receipt } = await send(txPromise);
  return Number(receipt.gasUsed);
}

/**
 * Deploy the full TSS stack:
 *   Identity -> Registry -> Settlement -> SecuritiesToken, CashToken
 * Returns the deployed instances + a `gas` map of deployment costs.
 *
 * Engines (OrderBook / AMM) are deployed separately by the helpers below so
 * we can measure their deployment cost in isolation.
 */
async function deployCore() {
  const [deployer, buyer, seller, lp, ...rest] = await ethers.getSigners();
  const gas = {};

  const Identity = await ethers.getContractFactory("Identity");
  const identityDeployTx = await Identity.deploy();
  await identityDeployTx.waitForDeployment();
  gas.deployIdentity = Number((await identityDeployTx.deploymentTransaction().wait()).gasUsed);

  const Registry = await ethers.getContractFactory("Registry");
  const registry = await Registry.deploy(await identityDeployTx.getAddress());
  await registry.waitForDeployment();
  gas.deployRegistry = Number((await registry.deploymentTransaction().wait()).gasUsed);

  const Settlement = await ethers.getContractFactory("Settlement");
  const settlement = await Settlement.deploy(
    await identityDeployTx.getAddress(),
    await registry.getAddress()
  );
  await settlement.waitForDeployment();
  gas.deploySettlement = Number((await settlement.deploymentTransaction().wait()).gasUsed);

  const SecuritiesToken = await ethers.getContractFactory("SecuritiesToken");
  const securitiesToken = await SecuritiesToken.deploy(
    "TestSecurity",
    "TSC",
    await identityDeployTx.getAddress()
  );
  await securitiesToken.waitForDeployment();
  gas.deploySecuritiesToken = Number((await securitiesToken.deploymentTransaction().wait()).gasUsed);

  const CashToken = await ethers.getContractFactory("CashToken");
  const cashToken = await CashToken.deploy(
    "TokenizedEUR",
    "tEUR",
    await identityDeployTx.getAddress()
  );
  await cashToken.waitForDeployment();
  gas.deployCashToken = Number((await cashToken.deploymentTransaction().wait()).gasUsed);

  // Whitelist the standard test actors as TRADERs.
  gas.whitelistTrader = await gasOf(identityDeployTx.whitelist(buyer.address, TRADER_ROLE));
  await send(identityDeployTx.whitelist(seller.address, TRADER_ROLE));
  await send(identityDeployTx.whitelist(lp.address, TRADER_ROLE));

  // Register both assets.
  gas.registerAssetCash = await gasOf(
    registry.registerAsset(await cashToken.getAddress(), CASH_TOKEN_TYPE, deployer.address)
  );
  gas.registerAssetSecurities = await gasOf(
    registry.registerAsset(await securitiesToken.getAddress(), SECURITIES_TYPE, deployer.address)
  );

  return {
    deployer,
    buyer,
    seller,
    lp,
    rest,
    identity: identityDeployTx,
    registry,
    settlement,
    cashToken,
    securitiesToken,
    gas,
  };
}

async function deployOrderBook(core) {
  const OrderBook = await ethers.getContractFactory("OrderBook");
  const orderBook = await OrderBook.deploy(
    await core.identity.getAddress(),
    await core.registry.getAddress(),
    await core.settlement.getAddress()
  );
  await orderBook.waitForDeployment();
  const deployGas = Number((await orderBook.deploymentTransaction().wait()).gasUsed);
  const authGas = await gasOf(core.settlement.authorizeEngine(await orderBook.getAddress()));
  return { orderBook, deployGas, authGas };
}

async function deployAmm(core, feeBps = 30) {
  const AMM = await ethers.getContractFactory("AMM");
  const amm = await AMM.deploy(
    await core.identity.getAddress(),
    await core.registry.getAddress(),
    await core.settlement.getAddress(),
    feeBps
  );
  await amm.waitForDeployment();
  const deployGas = Number((await amm.deploymentTransaction().wait()).gasUsed);
  await send(core.identity.whitelist(await amm.getAddress(), TRADER_ROLE));
  const authGas = await gasOf(core.settlement.authorizeEngine(await amm.getAddress()));
  const initGas = await gasOf(
    amm.initializePool(await core.cashToken.getAddress(), await core.securitiesToken.getAddress())
  );
  return { amm, deployGas, authGas, initGas };
}

/**
 * Create N additional funded TRADER signers on top of the default Hardhat
 * signers (used by the OrderBook depth-scaling test). Only works on the
 * in-process Hardhat network where we control the funding accounts.
 */
async function createFundedTraders(core, count) {
  const traders = [];
  const deployer = core.deployer;
  for (let i = 0; i < count; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
    await send(core.identity.whitelist(w.address, TRADER_ROLE));
    traders.push(w);
  }
  return traders;
}

function writeJson(filename, payload) {
  ensureResultsDir();
  const out = path.join(RESULTS_DIR, filename);
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  return out;
}

module.exports = {
  TRADER_ROLE,
  OPERATOR_ROLE,
  CASH_TOKEN_TYPE,
  SECURITIES_TYPE,
  ONE,
  TEN,
  HUNDRED,
  THOUSAND,
  MILLION,
  RESULTS_DIR,
  send,
  gasOf,
  deployCore,
  deployOrderBook,
  deployAmm,
  createFundedTraders,
  writeJson,
  ensureResultsDir,
};
