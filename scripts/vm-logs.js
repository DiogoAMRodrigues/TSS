#!/usr/bin/env node
/**
 * Tail the middleware log on the VM (Ctrl+C to stop).
 *
 * Usage:
 *   node scripts/vm-logs.js          # tail -f
 *   node scripts/vm-logs.js 200      # last 200 lines then follow
 */

"use strict";

const { spawn } = require("child_process");
const { cfg, sshArgs } = require("./vm-config");

const arg = process.argv[2];
const initialLines = arg && /^\d+$/.test(arg) ? Number(arg) : 100;

const remote = `tail -n ${initialLines} -f ${cfg.vmLogPath}`;
console.log(`>>> ssh tail (last ${initialLines} lines, then follow). Ctrl+C to stop.`);

const proc = spawn("ssh", sshArgs([remote]), { stdio: "inherit" });
proc.on("close", (code) => process.exit(code || 0));
process.on("SIGINT", () => {
  try {
    proc.kill("SIGINT");
  } catch (_) {}
});
