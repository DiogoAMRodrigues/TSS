/**
 * seed-frontend.js — one-off demo-data seeder for the TSS frontend.
 * ---------------------------------------------------------------------------
 * PURPOSE
 *   Populate a FRESH TSS deployment with real on-chain state so the frontend
 *   OrderBook and AMM pages can be screenshotted with live data:
 *     - AMM pool with reserves + a sane price (Pool Info shows reserves/price).
 *     - OrderBook with one resting BID and one resting ASK (non-crossing).
 *   The KYC / eIDAS / SAML middleware flow is BYPASSED entirely: whitelisting
 *   is a pure OPERATOR action (Identity.whitelist(addr, ROLE, hash)) and the
 *   deployer is auto-OPERATOR via Identity's constructor bootstrap, so we call
 *   it directly with a dummy attestation hash (ethers.ZeroHash).
 *
 * WHY A FRESH DEPLOYMENT (instead of seeding the existing one)
 *   scripts/deploy.js registers BOTH tokens under asset type "ERC20".
 *   AMM.initializePool (AMM.sol:112-113) REQUIRES the cash token be registered
 *   as "CASH_TOKEN" and the securities token as "SECURITIES". Registry has no
 *   re-type function and registerAsset reverts if already registered
 *   (Registry.sol:50). So against a normal deployment initializePool reverts
 *   with "AMM: invalid cash token type". This script therefore does its OWN
 *   clean deployment, registering CashToken=CASH_TOKEN and Securities=SECURITIES,
 *   then OVERWRITES deployments/besu.json so the frontend (and start-all.js's
 *   cached-deployment path) picks up the seeded contracts.
 *   It does NOT modify deploy.js / start-all.js / any contract.
 *
 * RUN FLOW
 *   1. Bring up Besu:           npm run start:ob      (let it boot, then Ctrl+C)
 *                               (or:  docker compose up -d)
 *   2. Seed:                    npx hardhat run scripts/seed-frontend.js --network besu
 *   3. Screenshot AMM page:     npm run start:amm
 *      Screenshot OrderBook:    npm run start:ob
 *      (Both reuse the seeded contracts: check-deployment.js sees Identity has
 *       code -> "VALID" -> start-all.js skips redeploy and copies the seeded
 *       addresses into frontend/.env.)
 *   4. The KYC banner still shows (these wallets aren't in the middleware DB),
 *      but it gates NOTHING visual — no disabled={!kycApproved} exists
 *      (OrderBookPage.jsx:378 / AMMPage.jsx:349). For a clean screenshot just
 *      delete the .kyc-warning div via F12. Import the printed TRADER private
 *      key into MetaMask to see "My Orders" + balances populate.
 *
 * ethers v6 (parseEther, encodeBytes32String, keccak256, toUtf8Bytes,
 * ZeroHash, getContractFactory().deploy()).
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

// --- Constants (verified against the contracts) ---
const TRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TRADER"));
const CASH_TOKEN_TYPE = ethers.encodeBytes32String("CASH_TOKEN");   // == bytes32("CASH_TOKEN")
const SECURITIES_TYPE = ethers.encodeBytes32String("SECURITIES");   // == bytes32("SECURITIES")
const AMM_FEE_BPS = 30; // 0.3%, same as deploy.js

// --- Seed amounts ---
const POOL_CASH = ethers.parseEther("100000"); // 100,000 tEUR
const POOL_SEC = ethers.parseEther("1000");    //   1,000 DSEC  -> price 100

// Resting, NON-CROSSING orders.
//   BID (buy):  tokenIn = cash, tokenOut = securities. Price = cash/sec = 90.
//   ASK (sell): tokenIn = securities, tokenOut = cash.  Price = cash/sec = 110.
// OrderBook._pricesCross(bid, ask): bid.amountIn*ask.amountIn >= bid.amountOut*ask.amountOut
//   => 90*1 >= 1*110  ->  90 >= 110  -> false  => they DO NOT cross, both rest.
const BID_CASH_IN = ethers.parseEther("90");
const BID_SEC_OUT = ethers.parseEther("1");
const ASK_SEC_IN = ethers.parseEther("1");
const ASK_CASH_OUT = ethers.parseEther("110");

// Trader funding (so the imported MetaMask wallet shows non-zero balances).
const TRADER_CASH_MINT = ethers.parseEther("10000");
const TRADER_SEC_MINT = ethers.parseEther("50");
const TRADER_GAS_ETH = ethers.parseEther("5"); // native ETH for gas if used from MetaMask

async function deployed(factoryName, ...args) {
  const Factory = await ethers.getContractFactory(factoryName);
  const instance = await Factory.deploy(...args);
  await instance.waitForDeployment();
  return instance;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Seeding with OPERATOR (deployer):", deployer.address);
  console.log("Network:", hre.network.name, "\n");

  // ------------------------------------------------------------------
  // 1. Deploy core stack
  // ------------------------------------------------------------------
  const identity = await deployed("Identity"); // deployer becomes OPERATOR (bootstrap)
  const identityAddr = await identity.getAddress();
  console.log("Identity     :", identityAddr);

  const registry = await deployed("Registry", identityAddr);
  const registryAddr = await registry.getAddress();
  console.log("Registry     :", registryAddr);

  const settlement = await deployed("Settlement", identityAddr, registryAddr);
  const settlementAddr = await settlement.getAddress();
  console.log("Settlement   :", settlementAddr);

  const orderBook = await deployed("OrderBook", identityAddr, registryAddr, settlementAddr);
  const orderBookAddr = await orderBook.getAddress();
  console.log("OrderBook    :", orderBookAddr);

  const amm = await deployed("AMM", identityAddr, registryAddr, settlementAddr, AMM_FEE_BPS);
  const ammAddr = await amm.getAddress();
  console.log("AMM          :", ammAddr);

  const securitiesToken = await deployed("SecuritiesToken", "DemoSecurity", "DSEC", identityAddr);
  const secAddr = await securitiesToken.getAddress();
  console.log("Securities   :", secAddr, "(DSEC)");

  const cashToken = await deployed("CashToken", "TokenizedEUR", "tEUR", identityAddr);
  const cashAddr = await cashToken.getAddress();
  console.log("CashToken    :", cashAddr, "(tEUR)\n");

  // ------------------------------------------------------------------
  // 2. Register assets with the CORRECT types (this is the whole point)
  // ------------------------------------------------------------------
  await (await registry.registerAsset(cashAddr, CASH_TOKEN_TYPE, deployer.address)).wait();
  await (await registry.registerAsset(secAddr, SECURITIES_TYPE, deployer.address)).wait();
  console.log("Registered: CashToken=CASH_TOKEN, SecuritiesToken=SECURITIES");

  // ------------------------------------------------------------------
  // 3. Authorize both engines on Settlement
  // ------------------------------------------------------------------
  await (await settlement.authorizeEngine(orderBookAddr)).wait();
  await (await settlement.authorizeEngine(ammAddr)).wait();
  console.log("Authorized engines: OrderBook + AMM on Settlement\n");

  // ------------------------------------------------------------------
  // 4. Seed the AMM pool
  //    - whitelist the pool address itself (required by submitOrder, and as the
  //      `to` party of addLiquidity's transferFrom, which checks whitelisting)
  //    - initializePool, mint cash+sec to operator, approve AMM, addLiquidity
  // ------------------------------------------------------------------
  await (await identity.whitelist(ammAddr, TRADER_ROLE, ethers.ZeroHash)).wait();
  console.log("Whitelisted AMM pool address as TRADER");

  await (await amm.initializePool(cashAddr, secAddr)).wait();
  console.log("AMM pool initialized");

  // Operator (deployer) is whitelisted via bootstrap, so mint-to-operator works.
  await (await cashToken.mint(deployer.address, POOL_CASH)).wait();
  await (await securitiesToken.mint(deployer.address, POOL_SEC)).wait();
  await (await cashToken.approve(ammAddr, POOL_CASH)).wait();
  await (await securitiesToken.approve(ammAddr, POOL_SEC)).wait();
  await (await amm.addLiquidity(POOL_CASH, POOL_SEC)).wait();
  console.log(
    `AMM liquidity added: ${ethers.formatEther(POOL_CASH)} tEUR / ` +
      `${ethers.formatEther(POOL_SEC)} DSEC (price 100)\n`
  );

  // ------------------------------------------------------------------
  // 5. Seed the OrderBook with two resting, non-crossing orders
  //    from two freshly funded + whitelisted random trader wallets.
  // ------------------------------------------------------------------
  const bidder = ethers.Wallet.createRandom().connect(ethers.provider); // buyer / BID
  const asker = ethers.Wallet.createRandom().connect(ethers.provider);  // seller / ASK

  for (const [label, w] of [["BIDDER", bidder], ["ASKER", asker]]) {
    await (await deployer.sendTransaction({ to: w.address, value: TRADER_GAS_ETH })).wait();
    await (await identity.whitelist(w.address, TRADER_ROLE, ethers.ZeroHash)).wait();
    console.log(`Whitelisted ${label}: ${w.address}`);
  }
  console.log();

  // Fund + approve the BIDDER (pays cash). Mint some securities too so the
  // imported wallet shows non-zero balances on BOTH legs in the frontend.
  await (await cashToken.mint(bidder.address, TRADER_CASH_MINT)).wait();
  await (await securitiesToken.mint(bidder.address, TRADER_SEC_MINT)).wait();
  await (await cashToken.connect(bidder).approve(settlementAddr, ethers.MaxUint256)).wait();
  await (await securitiesToken.connect(bidder).approve(settlementAddr, ethers.MaxUint256)).wait();

  // Fund + approve the ASKER (delivers securities).
  await (await securitiesToken.mint(asker.address, TRADER_SEC_MINT)).wait();
  await (await cashToken.mint(asker.address, TRADER_CASH_MINT)).wait();
  await (await securitiesToken.connect(asker).approve(settlementAddr, ethers.MaxUint256)).wait();
  await (await cashToken.connect(asker).approve(settlementAddr, ethers.MaxUint256)).wait();
  console.log("Minted balances + approved Settlement for both traders");

  // Submit BID first (no counterparty yet -> rests), then ASK (does not cross).
  await (
    await orderBook.connect(bidder).submitOrder(cashAddr, secAddr, BID_CASH_IN, BID_SEC_OUT)
  ).wait();
  console.log(
    `BID  submitted: ${ethers.formatEther(BID_CASH_IN)} tEUR -> ` +
      `${ethers.formatEther(BID_SEC_OUT)} DSEC (price 90)`
  );

  await (
    await orderBook.connect(asker).submitOrder(secAddr, cashAddr, ASK_SEC_IN, ASK_CASH_OUT)
  ).wait();
  console.log(
    `ASK  submitted: ${ethers.formatEther(ASK_SEC_IN)} DSEC -> ` +
      `${ethers.formatEther(ASK_CASH_OUT)} tEUR (price 110)\n`
  );

  // ------------------------------------------------------------------
  // 6. Overwrite deployments/besu.json with the seeded addresses
  //    (same shape as scripts/deploy.js so the frontend/start-all picks it up)
  // ------------------------------------------------------------------
  const addresses = {
    network: hre.network.name,
    deployedAt: new Date().toISOString(),
    contracts: {
      Identity: identityAddr,
      Registry: registryAddr,
      Settlement: settlementAddr,
      OrderBook: orderBookAddr,
      AMM: ammAddr,
      SecuritiesToken: secAddr,
      CashToken: cashAddr,
    },
  };
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const outputPath = path.join(deploymentsDir, `${hre.network.name}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(addresses, null, 2));
  console.log("Wrote seeded addresses ->", outputPath);

  // ------------------------------------------------------------------
  // 7. Verify on-chain state
  // ------------------------------------------------------------------
  const reserveCash = await amm.reserveCash();
  const reserveSec = await amm.reserveSecurities();
  const quoteOut = await amm.getAmountOut(cashAddr, ethers.parseEther("100"));
  const bid = await orderBook.getOrder(1);
  const ask = await orderBook.getOrder(2);

  console.log("\n--- VERIFICATION ---");
  console.log(`AMM reserves      : ${ethers.formatEther(reserveCash)} tEUR / ${ethers.formatEther(reserveSec)} DSEC`);
  console.log(`getAmountOut(100 tEUR) -> ${ethers.formatEther(quoteOut)} DSEC`);
  console.log(`Order #1 (BID) status=${bid.status} trader=${bid.trader}`);
  console.log(`Order #2 (ASK) status=${ask.status} trader=${ask.trader}`);

  const ok =
    reserveCash > 0n &&
    reserveSec > 0n &&
    quoteOut > 0n &&
    bid.status === 0n && // OrderStatus.OPEN
    ask.status === 0n;
  console.log(ok ? "VERIFY: PASS ✅" : "VERIFY: FAIL ❌");

  // ------------------------------------------------------------------
  // 8. MetaMask import key (BIDDER) — prints to stdout intentionally.
  // ------------------------------------------------------------------
  console.log("\n=== METAMASK IMPORT (BIDDER) ===");
  console.log("Address     :", bidder.address);
  console.log("Private key :", bidder.privateKey);
  console.log("ASKER address:", asker.address, "(key:", asker.privateKey + ")");
  console.log("Network: Besu RPC http://localhost:8545, chainId 1337");
  console.log("================================\n");

  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
