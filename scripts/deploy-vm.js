#!/usr/bin/env node
/**
 * Deploy current main branch to the INESC VM and restart middleware.
 *
 * Steps:
 *   1. Pre-flight: confirm local repo is clean and pushed to origin/main.
 *   2. ssh: git pull in repo dir on VM.
 *   3. ssh: install deps if package.json or package-lock.json changed.
 *   4. ssh: kill any running middleware process.
 *   5. ssh: nohup-launch middleware from $HOME so .env relative paths resolve.
 *   6. Poll public /health endpoint until ready (or timeout).
 *
 * Usage:
 *   node scripts/deploy-vm.js                  # full deploy
 *   node scripts/deploy-vm.js --skip-pull      # skip git pull (e.g. testing restart only)
 *   node scripts/deploy-vm.js --skip-install   # skip npm install even if lockfile changed
 *   node scripts/deploy-vm.js --no-verify-clean # bypass clean-tree check
 *
 * Env overrides: see scripts/vm-config.js
 *
 * Exits non-zero on any failure.
 */

"use strict";

const { spawn, execSync } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { cfg, sshArgs, describe } = require("./vm-config");

const args = process.argv.slice(2);
const SKIP_PULL = args.includes("--skip-pull");
const SKIP_INSTALL = args.includes("--skip-install");
const NO_VERIFY_CLEAN = args.includes("--no-verify-clean");

function fail(msg, err) {
  console.error(`\n[FAIL] ${msg}`);
  if (err) console.error(err.message || err);
  process.exit(1);
}
function ok(msg) {
  console.log(`[ OK ] ${msg}`);
}
function step(msg) {
  console.log(`\n>>> ${msg}`);
}

/**
 * Run an ssh command, stream output, resolve with exit code.
 * `remoteCmd` is a single shell string evaluated by the remote shell.
 */
function sshExec(remoteCmd, { tag = "vm" } = {}) {
  return new Promise((resolve, reject) => {
    const finalArgs = sshArgs([remoteCmd]);
    const proc = spawn("ssh", finalArgs, { stdio: ["inherit", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code));
  });
}

/**
 * Run an ssh command and capture stdout as a string. Reject on non-zero.
 */
function sshCapture(remoteCmd) {
  return new Promise((resolve, reject) => {
    const finalArgs = sshArgs([remoteCmd]);
    const proc = spawn("ssh", finalArgs, { stdio: ["inherit", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`ssh exit ${code}: ${err.trim()}`));
    });
  });
}

function pollHealth(url, timeoutMs, intervalMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const tick = () => {
      const elapsed = Date.now() - started;
      if (elapsed > timeoutMs) {
        return reject(new Error(`health did not respond within ${timeoutMs}ms (last URL ${url})`));
      }
      const req = lib.get(url, { timeout: 5000 }, (res) => {
        // drain
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve();
          }
          setTimeout(tick, intervalMs);
        });
      });
      req.on("error", () => setTimeout(tick, intervalMs));
      req.on("timeout", () => {
        req.destroy();
        setTimeout(tick, intervalMs);
      });
    };
    tick();
  });
}

function preflight() {
  step("Pre-flight: local git state");
  if (NO_VERIFY_CLEAN) {
    console.log("(--no-verify-clean) skipping clean-tree check");
    return;
  }
  let status = "";
  try {
    status = execSync("git status --porcelain", { encoding: "utf8" });
  } catch (err) {
    fail("could not run `git status` (are you in a git repo?)", err);
  }
  if (status.trim()) {
    console.error("\nUncommitted changes detected:\n" + status);
    fail(
      "refusing to deploy with a dirty working tree. " +
        "Commit + push first, or pass --no-verify-clean."
    );
  }
  ok("working tree clean");

  // Confirm local main is up to date with origin/main (so VM `git pull` will
  // actually pick up our changes).
  try {
    execSync("git fetch origin", { stdio: "ignore" });
  } catch (err) {
    console.warn("[warn] git fetch failed (offline?), continuing");
  }
  try {
    const local = execSync("git rev-parse @", { encoding: "utf8" }).trim();
    const remote = execSync("git rev-parse @{u}", { encoding: "utf8" }).trim();
    if (local !== remote) {
      fail(
        `local HEAD (${local.slice(0, 7)}) != upstream (${remote.slice(0, 7)}). ` +
          "Push your commits before deploying, or pass --no-verify-clean."
      );
    }
    ok(`HEAD ${local.slice(0, 7)} == origin/main`);
  } catch (err) {
    console.warn("[warn] could not compare HEAD to upstream:", err.message);
  }
}

async function main() {
  console.log("=== TSS VM Deploy ===\n");
  console.log(describe());

  preflight();

  // 1) git pull -----------------------------------------------------------
  if (SKIP_PULL) {
    console.log("\n(--skip-pull) skipping git pull on VM");
  } else {
    step("git pull on VM");
    const code = await sshExec(
      `cd ${cfg.vmRepoDir} && git pull --ff-only`,
      { tag: "git" }
    );
    if (code !== 0) fail(`git pull exited with ${code}`);
    ok("git pull complete");
  }

  // 2) npm install if lockfile changed -----------------------------------
  if (!SKIP_INSTALL) {
    step("checking if npm install is needed on VM");
    let needsInstall = false;
    try {
      const out = await sshCapture(
        // Compare modified time of node_modules vs package-lock.json.
        // If lockfile is newer, OR node_modules is missing, we install.
        `cd ${cfg.vmRepoDir} && ` +
          `if [ ! -d node_modules ]; then echo NEEDS; ` +
          `elif [ package-lock.json -nt node_modules ]; then echo NEEDS; ` +
          `else echo OK; fi`
      );
      needsInstall = out.includes("NEEDS");
    } catch (err) {
      console.warn("[warn] could not determine install state, will install anyway");
      needsInstall = true;
    }
    if (needsInstall) {
      step("npm install on VM");
      const code = await sshExec(
        `cd ${cfg.vmRepoDir} && npm install --omit=dev`,
        { tag: "npm" }
      );
      if (code !== 0) fail(`npm install exited with ${code}`);
      ok("dependencies up to date");
    } else {
      ok("node_modules current; skipping install");
    }
  } else {
    console.log("\n(--skip-install) skipping dependency install");
  }

  // 3) stop running middleware -------------------------------------------
  step("stopping any running middleware on VM");
  await sshExec(
    `pkill -f '${cfg.vmProcessPattern}' || true; sleep 1; ` +
      `if pgrep -f '${cfg.vmProcessPattern}' >/dev/null; then ` +
      `pkill -9 -f '${cfg.vmProcessPattern}' || true; fi; true`,
    { tag: "stop" }
  );
  ok("middleware stopped (or was not running)");

  // 4) launch middleware --------------------------------------------------
  step("launching middleware on VM");
  // setsid + redirected stdin so the process survives ssh disconnect cleanly.
  const launchCmd =
    `cd ${cfg.vmRunDir} && ` +
    // Truncate previous log to keep things readable across deploys
    `: > middleware.log && ` +
    `setsid ${cfg.vmStartCmd} </dev/null && ` +
    `sleep 1 && pgrep -f '${cfg.vmProcessPattern}' || ` +
    `(echo 'middleware did not start; tail of log:'; tail -n 50 middleware.log; exit 1)`;
  const launchCode = await sshExec(launchCmd, { tag: "start" });
  if (launchCode !== 0) fail(`middleware launch failed (exit ${launchCode})`);
  ok("middleware process running on VM");

  // 5) poll public health -------------------------------------------------
  step(`polling ${cfg.publicHealthUrl}`);
  try {
    await pollHealth(cfg.publicHealthUrl, cfg.healthTimeoutMs, cfg.healthIntervalMs);
    ok("public health endpoint returns 2xx");
  } catch (err) {
    // Show last log lines to help diagnose
    console.error("\n[FAIL]", err.message);
    try {
      console.error("\n--- tail of middleware.log on VM ---");
      await sshExec(`tail -n 80 ${cfg.vmLogPath}`, { tag: "log" });
    } catch (_) {}
    process.exit(1);
  }

  console.log("\n=== Deploy complete ===");
  console.log(`Public:  ${cfg.publicBaseUrl}`);
  console.log(`Health:  ${cfg.publicHealthUrl}`);
  console.log(`Logs:    npm run vm:logs`);
  console.log(`Restart: npm run vm:restart`);
}

main().catch((err) => fail("unhandled error", err));
