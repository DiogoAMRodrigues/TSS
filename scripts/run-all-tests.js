const { spawnSync } = require("child_process");

function runStep(step) {
  const env = { ...process.env, ...(step.env || {}) };
  console.log(`\n=== ${step.name} ===`);

  const result = spawnSync(step.command, {
    stdio: "inherit",
    shell: true,
    env,
  });

  if (result.status !== 0) {
    console.error(`\nStep failed: ${step.name}`);
    process.exit(result.status || 1);
  }
}

function getPlan(mode) {
  if (mode === "local") {
    return [
      { name: "Contracts test suite on local Hardhat", command: "npm run test:contracts:local" },
      { name: "Middleware unit/integration suite", command: "npm run test:middleware" },
      { name: "Middleware Hardhat-chain integration suite", command: "npm run test:middleware:hardhat-chain" },
    ];
  }

  if (mode === "besu-only") {
    return [
      { name: "Contracts test suite on Besu", command: "npm run test:contracts:besu" },
      { name: "Besu middleware readiness precheck", command: "npm run test:middleware:besu-check" },
      {
        name: "Middleware Besu-chain integration suite (strict)",
        command: "npx mocha test/integration/MiddlewareBesu.integration.test.js --timeout 120000",
        env: { BESU_TEST_REQUIRE_READY: "1" },
      },
    ];
  }

  if (mode === "besu") {
    return [
      { name: "Contracts test suite on Besu", command: "npm run test:contracts:besu" },
      { name: "Middleware unit/integration suite", command: "npm run test:middleware" },
      { name: "Middleware Hardhat-chain integration suite", command: "npm run test:middleware:hardhat-chain" },
      { name: "Besu middleware readiness precheck", command: "npm run test:middleware:besu-check" },
      {
        name: "Middleware Besu-chain integration suite (strict)",
        command: "npx mocha test/integration/MiddlewareBesu.integration.test.js --timeout 120000",
        env: { BESU_TEST_REQUIRE_READY: "1" },
      },
    ];
  }

  throw new Error(`Unsupported mode '${mode}'. Supported modes: local, besu-only, besu`);
}

function main() {
  const mode = process.argv[2] || "besu";
  const plan = getPlan(mode);

  console.log(`Running full test plan: ${mode}`);
  for (const step of plan) {
    runStep(step);
  }

  console.log("\nAll test plan steps completed successfully.");
}

main();
