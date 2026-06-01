#!/usr/bin/env node
/**
 * One-shot orchestrator: bring the WHOLE eIDAS stack up so you can hit
 * https://tss.dpss.inesc-id.pt/ from a real browser and authenticate with
 * Cartão de Cidadão / Chave Móvel Digital.
 *
 * What it does (in order, mirrors CLOUDTM_DEPLOYMENT_RUNBOOK):
 *
 *   LAPTOP:
 *     1. Pre-flight: git working tree clean + HEAD == origin/main.
 *     2. docker compose up -d           (besu 4-node IBFT on :8545)
 *     3. Wait for besu RPC.
 *     4. Deploy contracts if needed     (writes deployments/besu.json)
 *     5. Patch middleware/.env locally  (IDENTITY_ADDRESS=<deployed>,
 *                                        EIDAS_PROVIDER=real,
 *                                        RPC_URL=http://127.0.0.1:8545)
 *     6. Spawn reverse SSH tunnel in a NEW terminal window:
 *           ssh -N -R 8545:127.0.0.1:8545 ist1112192@10.16.144.70
 *        (so the VM's middleware can reach laptop besu via 127.0.0.1:8545)
 *
 *   VM (single ssh round-trip = 1 password pair):
 *     7. scp -r middleware/, artifacts/, package.json, package-lock.json -> ~/
 *     8. ssh: npm install if lockfile changed; kill old middleware; relaunch.
 *     9. Poll https://tss.dpss.inesc-id.pt/health until 2xx.
 *
 * After this:
 *   - Open https://tss.dpss.inesc-id.pt in a browser on any device.
 *   - Drive the KYC + eIDAS flow with real CC/CMD via AMA preprod.
 *   - Whitelisting hits laptop besu through the reverse tunnel.
 *
 * Password prompts:
 *   - 1× scp = 2 prompts (cloudtm jump + VM)
 *   - 1× ssh = 2 prompts (cloudtm jump + VM)
 *   - 1× tunnel ssh in new window = 2 prompts
 *   = 6 total. Acceptable.
 *
 * Usage:
 *   node scripts/deploy-vm.js                 # full deploy
 *   node scripts/deploy-vm.js --skip-local    # VM-only (assumes besu+tunnel already up)
 *   node scripts/deploy-vm.js --skip-sync     # don't scp
 *   node scripts/deploy-vm.js --skip-install  # skip npm install on VM
 *   node scripts/deploy-vm.js --skip-tunnel   # don't open a new tunnel window
 *   node scripts/deploy-vm.js --skip-deploy   # don't redeploy contracts even if invalid
 *   node scripts/deploy-vm.js --no-verify-clean
 */

"use strict";

const { spawn, spawnSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { cfg, sshArgs, scpArgs, sshTarget, describe } = require("./vm-config");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const SKIP_LOCAL = flag("--skip-local");
const SKIP_SYNC = flag("--skip-sync");
const SKIP_INSTALL = flag("--skip-install");
const SKIP_TUNNEL = flag("--skip-tunnel");
const SKIP_DEPLOY = flag("--skip-deploy");
const NO_VERIFY_CLEAN = flag("--no-verify-clean");

const REPO_ROOT = path.resolve(__dirname, "..");
const SYNC_PATHS = ["middleware", "artifacts", "package.json", "package-lock.json"];

// nvm prefix: non-interactive ssh skips .bashrc, so node/npm aren't on PATH.
const NVM_PREFIX =
  'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";';

const LOCAL_BESU_RPC = "http://127.0.0.1:8545";

// ---------- ui ----------------------------------------------------------------
function fail(msg, err) {
  console.error(`\n[FAIL] ${msg}`);
  if (err) console.error(err.message || err);
  process.exit(1);
}
const ok = (m) => console.log(`[ OK ] ${m}`);
const step = (m) => console.log(`\n>>> ${m}`);
const warn = (m) => console.warn(`[warn] ${m}`);

// ---------- ssh / scp helpers -------------------------------------------------
function sshExec(remoteCmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", sshArgs([remoteCmd]), { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code));
  });
}

function scpExec(sources, remoteDest) {
  return new Promise((resolve, reject) => {
    const proc = spawn("scp", scpArgs(sources, remoteDest), { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code));
  });
}

// ---------- besu RPC poll (laptop) -------------------------------------------
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 8545,
        path: "/",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 4000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.error) return reject(new Error(j.error.message || "rpc error"));
            resolve(j.result);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("rpc timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function waitForBesu(timeoutMs = 90_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const id = await rpcCall("eth_chainId");
      return id;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`besu RPC not ready after ${timeoutMs}ms: ${lastErr?.message || "?"}`);
}

// ---------- public health poll ------------------------------------------------
function pollHealth(url, timeoutMs, intervalMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const tick = () => {
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`health did not respond within ${timeoutMs}ms (${url})`));
      const req = lib.get(url, { timeout: 5000 }, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
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

// ---------- pre-flight --------------------------------------------------------
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
    console.error("\nUncommitted changes:\n" + status);
    fail("dirty working tree. Commit + push, or pass --no-verify-clean.");
  }
  ok("working tree clean");

  try {
    execSync("git fetch origin", { stdio: "ignore", cwd: REPO_ROOT });
    const local = execSync("git rev-parse @", { encoding: "utf8", cwd: REPO_ROOT }).trim();
    const remote = execSync("git rev-parse @{u}", { encoding: "utf8", cwd: REPO_ROOT }).trim();
    if (local !== remote) {
      fail(`local HEAD ${local.slice(0, 7)} != upstream ${remote.slice(0, 7)}. Push first or --no-verify-clean.`);
    }
    ok(`HEAD ${local.slice(0, 7)} == origin/main`);
  } catch (err) {
    warn(`could not compare HEAD to upstream: ${err.message}`);
  }
}

// ---------- local: docker besu -----------------------------------------------
function dockerComposeUp() {
  step("docker compose up -d   (laptop besu IBFT 4-node)");
  // Check docker daemon first
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    fail("Docker daemon unreachable. Start Docker Desktop and retry.");
  }
  try {
    execSync("docker compose up -d", { stdio: "inherit", cwd: REPO_ROOT });
  } catch (err) {
    fail("docker compose up failed", err);
  }
  ok("docker compose started");
}

async function ensureBesu() {
  step("waiting for besu RPC on 127.0.0.1:8545");
  const chainId = await waitForBesu();
  ok(`besu up (chainId=${chainId})`);
}

// ---------- local: deploy contracts ------------------------------------------
function contractsAreValid() {
  const deploymentsPath = path.join(REPO_ROOT, "deployments", "besu.json");
  if (!fs.existsSync(deploymentsPath)) return false;
  try {
    const out = execSync("npx hardhat run --network besu scripts/check-deployment.js", {
      encoding: "utf8",
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().endsWith("VALID");
  } catch {
    return false;
  }
}

function deployContracts() {
  step("deploying contracts to local besu");
  if (SKIP_DEPLOY) {
    console.log("(--skip-deploy) skipping deploy");
    return;
  }
  if (contractsAreValid()) {
    ok("existing deployment still valid; skipping");
    return;
  }
  try {
    execSync("npx hardhat run scripts/deploy.js --network besu", {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
  } catch (err) {
    fail("contract deploy failed", err);
  }
  ok("contracts deployed");
}

// ---------- local: patch middleware/.env -------------------------------------
function patchMiddlewareEnv() {
  step("patching middleware/.env locally (IDENTITY_ADDRESS, RPC_URL, EIDAS_PROVIDER=real)");
  const envPath = path.join(REPO_ROOT, "middleware", ".env");
  const examplePath = path.join(REPO_ROOT, "middleware", ".env.example");
  if (!fs.existsSync(envPath)) {
    if (!fs.existsSync(examplePath)) fail("no middleware/.env or .env.example to seed from");
    fs.copyFileSync(examplePath, envPath);
    warn("middleware/.env was missing; seeded from .env.example");
  }

  const deploymentsPath = path.join(REPO_ROOT, "deployments", "besu.json");
  if (!fs.existsSync(deploymentsPath))
    fail("deployments/besu.json missing — contract deploy must run first");
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const identityAddr = deployments.contracts?.Identity;
  if (!identityAddr) fail("deployments/besu.json missing contracts.Identity");

  let env = fs.readFileSync(envPath, "utf8");
  const replacements = {
    IDENTITY_ADDRESS: identityAddr,
    RPC_URL: LOCAL_BESU_RPC, // VM uses tunnel → 127.0.0.1:8545; laptop direct same value
    EIDAS_PROVIDER: "real",
  };
  for (const [k, v] of Object.entries(replacements)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(env)) env = env.replace(re, `${k}=${v}`);
    else env += `\n${k}=${v}`;
  }
  fs.writeFileSync(envPath, env);
  ok(`IDENTITY_ADDRESS=${identityAddr}`);
  ok(`RPC_URL=${LOCAL_BESU_RPC}`);
  ok(`EIDAS_PROVIDER=real`);
}

// ---------- reverse SSH tunnel (new window) -----------------------------------
function spawnTunnelWindow() {
  step("spawning reverse SSH tunnel in a new window  (laptop besu :8545 -> VM :8545)");
  if (SKIP_TUNNEL) {
    console.log("(--skip-tunnel) leaving tunnel to caller");
    return;
  }

  // Build the ssh argv ourselves (don't reuse sshArgs — we want -N -R, no command).
  const tunnelArgs = [];
  if (cfg.sshConfig) tunnelArgs.push("-F", cfg.sshConfig);
  if (cfg.sshJump) tunnelArgs.push("-J", cfg.sshJump);
  // Keep tunnel alive across NAT idle; auto-die if peer is gone.
  tunnelArgs.push(
    "-N",
    "-R",
    "8545:127.0.0.1:8545",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    sshTarget()
  );

  // Quote each arg for cmd.exe inside `start "title" cmd /k ssh ...`
  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const cmdLine = ["ssh", ...tunnelArgs].map(quote).join(" ");

  if (process.platform === "win32") {
    // `start "" cmd /k ...` opens a new console window that survives this script.
    // Empty title MUST be present (start treats first quoted arg as window title).
    // Use shell:true so cmd parses the whole line — Node's argv quoting otherwise
    // mangles the nested quotes around the ssh args.
    const fullLine = `start "" cmd /k ${cmdLine}`;
    const r = spawnSync(fullLine, { stdio: "inherit", shell: true });
    if (r.status !== 0) fail(`failed to spawn tunnel window (exit ${r.status})`);
    ok("tunnel window opened — enter the 2 passwords there. Leave it open.");
    console.log("    (close that window when you're done to drop the tunnel)");
  } else {
    // mac/linux fallback: just background it.
    const proc = spawn("ssh", tunnelArgs, { stdio: "inherit", detached: true });
    proc.unref();
    ok("tunnel started in background (PID " + proc.pid + ")");
  }
}

// ---------- VM: scp + install + restart --------------------------------------
function resolveSyncPaths() {
  const out = [];
  for (const rel of SYNC_PATHS) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      warn(`skipping missing path: ${rel}`);
      continue;
    }
    out.push(abs);
  }
  if (!out.length) fail("nothing to sync (no SYNC_PATHS exist locally)");
  return out;
}

async function syncToVm() {
  if (SKIP_SYNC) {
    console.log("\n(--skip-sync) skipping scp upload");
    return;
  }
  step("scp -r local files -> VM:~/");
  console.log("    paths: " + SYNC_PATHS.join(", "));
  const code = await scpExec(resolveSyncPaths(), "~/");
  if (code !== 0) fail(`scp exited with ${code}`);
  ok("files synced to VM");
}

async function restartMiddlewareOnVm() {
  step("VM: install deps (if needed) + restart middleware");

  // Install if node_modules is missing OR if a critical runtime dep is missing
  // (catches the "node_modules exists but is stale" case after package.json
  // changes — scp resets mtimes so we can't trust file timestamps).
  const installBlock = SKIP_INSTALL
    ? `echo '(--skip-install) skipping dependency install';`
    : `cd ${cfg.vmRepoDir} && ` +
      `if [ ! -d node_modules ] || [ ! -d node_modules/ethers ]; then ` +
      `  echo '>>> npm install (node_modules missing or stale)'; ` +
      `  npm install --omit=dev || exit 1; ` +
      `else ` +
      `  echo 'node_modules present; skipping install'; ` +
      `fi;`;

  // Port-based kill instead of `pkill -f <pattern>`:
  //   - pkill -f matches the running ssh-driven bash itself (its argv contains
  //     the pattern string), so the session self-killed (exit -1 / 4294967295).
  //   - fuser -k targets the listening sockets directly.
  // We also clear :8545 in case an orphan reverse tunnel from a prior run is
  // still holding the remote forward port (otherwise the new tunnel fails with
  // "remote port forwarding failed for listen port 8545").
  const restartBlock =
    `cd ${cfg.vmRunDir} && ` +
    `fuser -k 8545/tcp 2>/dev/null; ` +
    `fuser -k 3000/tcp 2>/dev/null; ` +
    `sleep 1; ` +
    `: > middleware.log; ` +
    `nohup ${cfg.vmStartCmd.replace(/ &$/, "")} </dev/null >middleware.log 2>&1 & ` +
    `disown; ` +
    `sleep 2; ` +
    `if (ss -tln 2>/dev/null || netstat -tln) | grep -q ':3000 '; then ` +
    `  echo 'middleware listening on :3000'; ` +
    `else ` +
    `  echo 'middleware did NOT start; tail of log:'; ` +
    `  tail -n 80 middleware.log; ` +
    `  exit 1; ` +
    `fi`;

  const fullCmd = `${NVM_PREFIX} ${installBlock} ${restartBlock}`;
  const code = await sshExec(fullCmd);
  if (code !== 0) fail(`install+restart exited with ${code}`);
  ok("middleware running on VM");
}

// ---------- main --------------------------------------------------------------
async function main() {
  console.log("=== TSS one-shot deploy ===\n");
  console.log(describe());

  preflight();

  // ---------- LOCAL prep ----------
  if (!SKIP_LOCAL) {
    dockerComposeUp();
    await ensureBesu();
    deployContracts();
    patchMiddlewareEnv();
  } else {
    console.log("\n(--skip-local) skipping docker, deploy, .env patch");
  }

  // ---------- VM ----------
  // Restart middleware BEFORE opening the tunnel. The restart block also frees
  // VM port 8545 (orphan reverse-forward from a prior run), otherwise the new
  // tunnel fails with "remote port forwarding failed for listen port 8545".
  // Middleware uses a lazy JsonRpcProvider — it doesn't need the tunnel to
  // start, only to serve KYC requests.
  await syncToVm();
  await restartMiddlewareOnVm();

  // ---------- TUNNEL ----------
  if (!SKIP_LOCAL) {
    spawnTunnelWindow();
  }

  // ---------- VERIFY ----------
  step(`polling ${cfg.publicHealthUrl}`);
  try {
    await pollHealth(cfg.publicHealthUrl, cfg.healthTimeoutMs, cfg.healthIntervalMs);
    ok("public health endpoint returns 2xx");
  } catch (err) {
    console.error("\n[FAIL]", err.message);
    try {
      console.error("\n--- tail of middleware.log on VM ---");
      await sshExec(`tail -n 80 ${cfg.vmLogPath}`);
    } catch {}
    process.exit(1);
  }

  console.log("\n=== STACK UP ===");
  console.log(`Public:  ${cfg.publicBaseUrl}`);
  console.log(`Health:  ${cfg.publicHealthUrl}`);
  console.log("");
  console.log("Now drive a real-CC KYC flow against the public URL.");
  console.log("Tunnel window must stay open — closing it kills besu access.");
  console.log("");
  console.log(`Logs:    npm run vm:logs`);
  console.log(`Restart: npm run vm:restart`);
}

main().catch((err) => fail("unhandled error", err));
