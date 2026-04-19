const fs = require("fs");
const path = require("path");

function main() {
  const root = path.resolve(__dirname, "..");
  const deploymentPath = path.join(root, "deployments", "besu.json");
  const templatePath = path.join(root, "middleware", ".env.example");
  const envPath = path.join(root, "middleware", ".env");

  if (!fs.existsSync(templatePath)) {
    throw new Error("Missing middleware/.env.example");
  }

  if (!fs.existsSync(deploymentPath)) {
    throw new Error("Missing deployments/besu.json. Run deploy first: npx hardhat run scripts/deploy.js --network besu");
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const identityAddress = deployment?.contracts?.Identity;

  if (!identityAddress) {
    throw new Error("Identity address not found in deployments/besu.json");
  }

  const content = fs.readFileSync(templatePath, "utf-8")
    .replace("IDENTITY_ADDRESS=0x0000000000000000000000000000000000000000", `IDENTITY_ADDRESS=${identityAddress}`);

  fs.writeFileSync(envPath, content);
  console.log(`Middleware env written to ${envPath}`);
  console.log("Fill OPERATOR_PRIVATE_KEY in middleware/.env before starting middleware.");
}

main();
