#!/usr/bin/env node
/**
 * Deploy local repo to the INESC VM and restart middleware.
 *
 * The VM has no git — sync is via `scp -r` of the relevant project paths.
 * Per CLOUDTM_DEPLOYMENT_RUNBOOK: copy middleware/, scripts/, artifacts/,
 * package.json, package-lock.json into ~ on the VM. .env and certs live
 * on the VM only (not synced).
 *
 * Steps:
 *   1. Pre-flight: confirm local repo is clean and pushed (audit trail only;
 *      the actual sync is from local files, not git).
 *   2. scp -r: middleware/, scripts/, artifacts/, package.json, package-lock.json -> VM:~/
 *   3. ssh: install deps if package-lock.json indicates change.
 *   4. ssh: kill running middleware + relaunch from ~ (so .env relative paths resolve).
 *   5. Poll public /health endpoint until ready (or timeout).
 *
 * Usage:
 *   node scripts/deploy-vm.js                  # full deploy
 *   node scripts/deploy-vm.js --skip-sync      # don't scp, just restart
 *   node scripts/deploy-vm.js --skip-install   # skip npm install even if lockfile changed
 *   node scripts/deploy-vm.js --no-verify-clean # bypass clean-tree check
 *
 * NOTE: Each ssh/scp call needs 2 password prompts (cloudtm jump, then VM).
 * Expect ~3 prompt-pairs per full deploy.
 *
 * Env overrides: see scripts/vm-config.js
 */

"use strict";

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { cfg, sshArgs, scpArgs, describe } = require("./vm-config");

const args = process.argv.slice(2);
const SKIP_SYNC = args.includes("--skip-sync") || args.includes("--skip-pull");
const SKIP_INSTALL = args.includes("--skip-install");
const NO_VERIFY_CLEAN = args.includes("--no-verify-clean");

// Repo root = parent of scripts/
const REPO_ROOT = path.resolve(__dirname, "..");

// Paths to sync (relative to REPO_ROOT). Matches runbook step 3.
// .env and middleware/certs/ are intentionally NOT synced — they live on the VM.
const SYNC_PATHS = [
  "middleware",
  "scripts",
  "artifacts",
  "package.json",
  "package-lock.json",
];

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

function sshExec(remoteCmd) {
  return new Promise((resolve, reject) => {
    const finalArgs = sshArgs([remoteCmd]);
    // Inherit ALL stdio so ssh gets a real TTY for password prompts on Windows.
    const proc = spawn("ssh", finalArgs, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code));
  });
}

function sshCapture(remoteCmd) {
  return new Promise((resolve, reject) => {
    const finalArgs = sshArgs([remoteCmd]);
    // Inherit stdin + stderr (password prompts), pipe stdout to capture.
    const proc = spawn("ssh", finalArgs, { stdio: ["inherit", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`ssh exit ${code}`));
    });
  });
}

function scpExec(sources, remoteDest) {
  return new Promise((resolve, reject) => {
    const finalArgs = scpArgs(sources, remoteDest);
    const proc = spawn("scp", finalArgs, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code));
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
    status = execSync("git status --porcelain", { encoding: "utf8", cwd: REPO_ROOT });
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

  try {
    execSync("git fetch origin", { stdio: "ignore", cwd: REPO_ROOT });
  } catch (err) {
    console.warn("[warn] git fetch failed (offline?), continuing");
  }
  try {
    const local = execSync("git rev-parse @", { encoding: "utf8", cwd: REPO_ROOT }).trim();
    const remote = execSync("git rev-parse @{u}", { encoding: "utf8", cwd: REPO_ROOT }).trim();
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

function resolveSyncPaths() {
  const resolved = [];
  for (const rel of SYNC_PATHS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`[warn] skipping missing path: ${rel}`);
      continue;
    }
    resolved.push(abs);
  }
  if (!resolved.length) fail("nothing to sync (no SYNC_PATHS exist locally)");
  return resolved;
}

async function main() {
  console.log("=== TSS VM Deploy ===\n");
  console.log(describe());

  preflight();

  // 1) sync local files to VM via scp ------------------------------------
  if (SKIP_SYNC) {
    console.log("\n(--skip-sync) skipping scp upload");
  } else {
    step("scp -r local files to VM:~/");
    console.log("    paths: " + SYNC_PATHS.join(", "));
    const sources = resolveSyncPaths();
    const code = await scpExec(sources, "~/");
    if (code !== 0) fail(`scp exited with ${code}`);
    ok("files synced");
  }

  // 2) npm install if needed ---------------------------------------------
  if (!SKIP_INSTALL) {
    step("checking if npm install is needed on VM");
    let needsInstall = false;
    try {
      const out = await sshCapture(
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
      const code = await sshExec(`cd ${cfg.vmRepoDir} && npm install --omit=dev`);
      if (code !== 0) fail(`npm install exited with ${code}`);
      ok("dependencies up to date");
    } else {
      ok("node_modules current; skipping install");
    }
  } else {
    console.log("\n(--skip-install) skipping dependency install");
  }

  // 3) restart middleware (stop + start in ONE ssh call to save passwords)
  step("restarting middleware on VM");
  const restartCmd =
    // Stop
    `pkill -f '${cfg.vmProcessPattern}' || true; sleep 1; ` +
    `if pgrep -f '${cfg.vmProcessPattern}' >/dev/null; then ` +
    `pkill -9 -f '${cfg.vmProcessPattern}' || true; fi; ` +
    // Start (from ~ so .env relative paths resolve)
    `cd ${cfg.vmRunDir} && ` +
    `: > middleware.log && ` +
    `setsid ${cfg.vmStartCmd} </dev/null && ` +
    `sleep 1 && ` +
    `if pgrep -f '${cfg.vmProcessPattern}' >/dev/null; then ` +
    `echo 'middleware running'; ` +
    `else echo 'middleware did NOT start; tail of log:'; tail -n 50 middleware.log; exit 1; fi`;
  const restartCode = await sshExec(restartCmd);
  if (restartCode !== 0) fail(`middleware restart failed (exit ${restartCode})`);
  ok("middleware running on VM");

  // 4) poll public health -------------------------------------------------
  step(`polling ${cfg.publicHealthUrl}`);
  try {
    await pollHealth(cfg.publicHealthUrl, cfg.healthTimeoutMs, cfg.healthIntervalMs);
    ok("public health endpoint returns 2xx");
  } catch (err) {
    console.error("\n[FAIL]", err.message);
    try {
      console.error("\n--- tail of middleware.log on VM ---");
      await sshExec(`tail -n 80 ${cfg.vmLogPath}`);
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
