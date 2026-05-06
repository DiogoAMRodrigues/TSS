const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const deploymentsPath = path.join(__dirname, "..", "deployments", "besu.json");
  if (!fs.existsSync(deploymentsPath)) {
    console.log("INVALID");
    return;
  }

  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const provider = hre.ethers.provider;

  // Check if Identity contract has code
  const code = await provider.getCode(deployments.contracts.Identity);
  if (code && code !== "0x") {
    console.log("VALID");
  } else {
    console.log("INVALID");
  }
}

main().catch(() => {
  console.log("INVALID");
});
