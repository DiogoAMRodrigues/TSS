/**
 * Shared VM deployment config.
 *
 * All values overridable via env vars so the scripts work the same from
 * D:\ or any other machine. Defaults match the INESC cluster setup
 * (ist1112192 user, jump host inesc-headnode, VM 10.16.144.70).
 */

"use strict";

const path = require("path");
const os = require("os");

const DEFAULT_SSH_CONFIG =
  "D:\\Main\\Documents\\Academic\\IST\\TESE\\cluster_configuration_ist1112192\\config";

const cfg = {
  // SSH plumbing
  sshUser: process.env.VM_SSH_USER || "ist1112192",
  sshHost: process.env.VM_SSH_HOST || "10.16.144.70",
  sshJump: process.env.VM_SSH_JUMP || "inesc-headnode",
  sshConfig: process.env.VM_SSH_CONFIG || DEFAULT_SSH_CONFIG,

  // Remote layout
  // Repo is cloned at $HOME on the VM, so:
  //   - `git pull` runs from $HOME
  //   - middleware launches as `node middleware/src/server.js` from $HOME
  //   - certs live at $HOME/middleware/certs/
  vmRepoDir: process.env.VM_REPO_DIR || "~",
  vmRunDir: process.env.VM_RUN_DIR || "~",
  vmStartCmd:
    process.env.VM_START_CMD ||
    "nohup node middleware/src/server.js > middleware.log 2>&1 &",
  vmLogPath: process.env.VM_LOG_PATH || "~/middleware.log",
  vmProcessPattern: process.env.VM_PROCESS_PATTERN || "node middleware/src/server.js",

  // Public endpoints (reverse-tunnel exposes middleware behind nginx + tss.dpss.inesc-id.pt)
  publicHealthUrl: process.env.VM_PUBLIC_HEALTH_URL || "https://tss.dpss.inesc-id.pt/health",
  publicBaseUrl: process.env.VM_PUBLIC_BASE_URL || "https://tss.dpss.inesc-id.pt",

  // Polling
  healthTimeoutMs: Number(process.env.VM_HEALTH_TIMEOUT_MS || 60000),
  healthIntervalMs: Number(process.env.VM_HEALTH_INTERVAL_MS || 2000),
};

function sshTarget() {
  return `${cfg.sshUser}@${cfg.sshHost}`;
}

function sshArgs(extra = []) {
  const args = [];
  if (cfg.sshConfig) {
    args.push("-F", cfg.sshConfig);
  }
  if (cfg.sshJump) {
    args.push("-J", cfg.sshJump);
  }
  // No ConnectTimeout: interactive password prompts on jump + VM can take >15s.
  // Target MUST come before the remote command (ssh syntax: ssh [opts] host [cmd...]).
  args.push(sshTarget());
  args.push(...extra);
  return args;
}

function describe() {
  return [
    `  SSH         : ${sshTarget()}`,
    `  Jump        : ${cfg.sshJump}`,
    `  SSH config  : ${cfg.sshConfig}`,
    `  Repo dir    : ${cfg.vmRepoDir}`,
    `  Run dir     : ${cfg.vmRunDir}`,
    `  Start cmd   : ${cfg.vmStartCmd}`,
    `  Log path    : ${cfg.vmLogPath}`,
    `  Public URL  : ${cfg.publicBaseUrl}`,
  ].join("\n");
}

/**
 * Build scp args. Supports multiple sources (local paths) and one destination
 * (remote path on the VM). Mirrors sshArgs jump/config plumbing.
 *
 * scp -r <opts> src1 src2 ... user@host:dest
 */
function scpArgs(sources, remoteDest) {
  const args = ["-r"];
  if (cfg.sshConfig) {
    args.push("-F", cfg.sshConfig);
  }
  if (cfg.sshJump) {
    args.push("-J", cfg.sshJump);
  }
  args.push(...sources);
  args.push(`${sshTarget()}:${remoteDest}`);
  return args;
}

module.exports = { cfg, sshTarget, sshArgs, scpArgs, describe };
