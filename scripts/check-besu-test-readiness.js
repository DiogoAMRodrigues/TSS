const fs = require("fs");
const path = require("path");
const { JsonRpcProvider } = require("ethers");

const DEFAULT_BESU_OPERATOR_PRIVATE_KEY =
  "0x1ca60577f0b6dbf9ebddeb330615c25824f2e458eed044b0abc3ac954eb1f3db";

function loadIdentityFromDeployment() {
  const deploymentPath = path.resolve(process.cwd(), "deployments", "besu.json");
  if (!fs.existsSync(deploymentPath)) {
    return null;
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  return deployment?.contracts?.Identity || null;
}

async function main() {
  const rpcUrl = process.env.BESU_RPC_URL || process.env.RPC_URL || "http://localhost:8545";
  const identityAddress = process.env.BESU_IDENTITY_ADDRESS || process.env.IDENTITY_ADDRESS || loadIdentityFromDeployment();
  const explicitOperatorKey =
    process.env.BESU_OPERATOR_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY || null;
  const operatorKey = explicitOperatorKey || DEFAULT_BESU_OPERATOR_PRIVATE_KEY;

  const checks = [];

  checks.push({
    name: "Identity address",
    ok: Boolean(identityAddress),
    detail: identityAddress || "missing (set BESU_IDENTITY_ADDRESS / IDENTITY_ADDRESS or create deployments/besu.json)",
  });

  checks.push({
    name: "Operator private key",
    ok: Boolean(operatorKey),
    detail: explicitOperatorKey
      ? "present"
      : "using default local dev key (set BESU_OPERATOR_PRIVATE_KEY or OPERATOR_PRIVATE_KEY to override)",
  });

  let rpcOk = false;
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    await provider.getBlockNumber();
    rpcOk = true;
  } catch (error) {
    rpcOk = false;
  }

  checks.push({
    name: "RPC reachability",
    ok: rpcOk,
    detail: rpcOk ? `${rpcUrl} reachable` : `${rpcUrl} not reachable`,
  });

  for (const check of checks) {
    console.log(`${check.ok ? "[OK]" : "[MISSING]"} ${check.name}: ${check.detail}`);
  }

  const allOk = checks.every((c) => c.ok);
  if (!allOk) {
    process.exit(1);
  }

  console.log("Besu integration test readiness: READY");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
