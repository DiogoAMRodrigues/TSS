#!/usr/bin/env node
/**
 * Restart middleware on the VM without pulling new code.
 *
 * Useful after editing the .env on the VM directly.
 */

"use strict";

const { spawn } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { cfg, sshArgs } = require("./vm-config");

function sshExec(remoteCmd, tag) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", sshArgs([remoteCmd]), {
      stdio: ["inherit", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
    proc.on("error", reject);
    proc.on("close", resolve);
  });
}

function pollHealth(url, timeoutMs, intervalMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const tick = () => {
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`health did not respond within ${timeoutMs}ms`));
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

(async () => {
  console.log(">>> stopping middleware on VM");
  await sshExec(
    `pkill -f '${cfg.vmProcessPattern}' || true; sleep 1; ` +
      `if pgrep -f '${cfg.vmProcessPattern}' >/dev/null; then ` +
      `pkill -9 -f '${cfg.vmProcessPattern}' || true; fi; true`,
    "stop"
  );
  console.log(">>> launching middleware on VM");
  const launchCmd =
    `cd ${cfg.vmRunDir} && : > middleware.log && ` +
    `setsid ${cfg.vmStartCmd} </dev/null && sleep 1 && ` +
    `pgrep -f '${cfg.vmProcessPattern}' || ` +
    `(echo 'middleware did not start; tail of log:'; tail -n 50 middleware.log; exit 1)`;
  const code = await sshExec(launchCmd, "start");
  if (code !== 0) {
    console.error("[FAIL] launch failed");
    process.exit(code || 1);
  }
  console.log(`>>> polling ${cfg.publicHealthUrl}`);
  try {
    await pollHealth(cfg.publicHealthUrl, cfg.healthTimeoutMs, cfg.healthIntervalMs);
    console.log("[ OK ] public health 2xx");
  } catch (err) {
    console.error(`[FAIL] ${err.message}`);
    await sshExec(`tail -n 80 ${cfg.vmLogPath}`, "log");
    process.exit(1);
  }
})();
