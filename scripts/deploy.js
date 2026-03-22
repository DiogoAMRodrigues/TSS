const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // 1. Deploy Identity
  const Identity = await hre.ethers.getContractFactory("Identity");
  const identity = await Identity.deploy();
  await identity.waitForDeployment();
  console.log("Identity deployed to:", await identity.getAddress());

  // 2. Deploy Registry
  const Registry = await hre.ethers.getContractFactory("Registry");
  const registry = await Registry.deploy(await identity.getAddress());
  await registry.waitForDeployment();
  console.log("Registry deployed to:", await registry.getAddress());

  // 3. Deploy Settlement
  const Settlement = await hre.ethers.getContractFactory("Settlement");
  const settlement = await Settlement.deploy(
    await identity.getAddress(),
    await registry.getAddress()
  );
  await settlement.waitForDeployment();
  console.log("Settlement deployed to:", await settlement.getAddress());

  // 4. Deploy OrderBook
  const OrderBook = await hre.ethers.getContractFactory("OrderBook");
  const orderBook = await OrderBook.deploy(
    await identity.getAddress(),
    await registry.getAddress(),
    await settlement.getAddress()
  );
  await orderBook.waitForDeployment();
  console.log("OrderBook deployed to:", await orderBook.getAddress());

  // 5. Deploy SecuritiesToken
  const SecuritiesToken = await hre.ethers.getContractFactory("SecuritiesToken");
  const securitiesToken = await SecuritiesToken.deploy(
    "TestSecurity",
    "TSC",
    await identity.getAddress()
  );
  await securitiesToken.waitForDeployment();
  console.log("SecuritiesToken deployed to:", await securitiesToken.getAddress());

  // 6. Deploy CashToken
  const CashToken = await hre.ethers.getContractFactory("CashToken");
  const cashToken = await CashToken.deploy(
    "TokenizedEUR",
    "tEUR",
    await identity.getAddress()
  );
  await cashToken.waitForDeployment();
  console.log("CashToken deployed to:", await cashToken.getAddress());

  // 7. Register both tokens in Registry
  const ERC20_TYPE = hre.ethers.encodeBytes32String("ERC20");
  await registry.registerAsset(
    await securitiesToken.getAddress(),
    ERC20_TYPE,
    deployer.address
  );
  console.log("SecuritiesToken registered in Registry");

  await registry.registerAsset(
    await cashToken.getAddress(),
    ERC20_TYPE,
    deployer.address
  );
  console.log("CashToken registered in Registry");

  console.log("\nDeployment complete!");
  console.log("Identity:", await identity.getAddress());
  console.log("Registry:", await registry.getAddress());
  console.log("Settlement:", await settlement.getAddress());
  console.log("OrderBook:", await orderBook.getAddress());
  console.log("SecuritiesToken:", await securitiesToken.getAddress());
  console.log("CashToken:", await cashToken.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});