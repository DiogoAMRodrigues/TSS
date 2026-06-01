#!/usr/bin/env node
/**
 * Quick health check of the deployed TSS middleware.
 *
 * - Hits public /health
 * - Optionally tails middleware.log on VM (--logs)
 *
 * Usage:
 *   node scripts/check-vm.js
 *   node scripts/check-vm.js --logs       # also print last 50 log lines
 */

"use strict";

const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const { URL } = require("url");
const { cfg, sshArgs } = require("./vm-config");

const args = process.argv.slice(2);
const SHOW_LOGS = args.includes("--logs");

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
  });
}

function sshExec(remoteCmd, tag = "vm") {
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

(async () => {
  console.log(`Checking ${cfg.publicHealthUrl} ...`);
  try {
    const r = await get(cfg.publicHealthUrl);
    if (r.status >= 200 && r.status < 300) {
      console.log(`[ OK ] ${r.status}`);
      if (r.body) console.log(`       ${r.body.trim().slice(0, 200)}`);
    } else {
      console.error(`[FAIL] HTTP ${r.status}`);
      console.error(r.body);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[FAIL] ${err.message}`);
    process.exitCode = 1;
  }

  // Process check on VM
  console.log("\nVM process check:");
  await sshExec(
    `pgrep -af '${cfg.vmProcessPattern}' || echo '(no middleware process running)'`,
    "ps"
  );

  if (SHOW_LOGS) {
    console.log("\nLast 50 log lines:");
    await sshExec(`tail -n 50 ${cfg.vmLogPath}`, "log");
  }
})();
