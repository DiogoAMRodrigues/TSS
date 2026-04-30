#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const http = require('http');

const BESU_RPC_URL = 'http://localhost:8545';
const MIDDLEWARE_HEALTH_URL = 'http://localhost:3000/api/kyc/health';
const BESU_TIMEOUT = 60000; // 60 seconds
const MIDDLEWARE_TIMEOUT = 15000; // 15 seconds

let middlewareProcess = null;
let frontendProcess = null;

/**
 * Poll an HTTP endpoint until it responds successfully
 */
function pollEndpoint(url, timeout, name) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const poll = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        reject(new Error(`${name} did not respond within ${timeout}ms`));
        return;
      }

      const request = http.get(url, { timeout: 5000 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          setTimeout(poll, 1000);
        }
      });

      request.on('error', () => {
        setTimeout(poll, 1000);
      });

      request.on('timeout', () => {
        request.destroy();
        setTimeout(poll, 1000);
      });
    };

    poll();
  });
}

/**
 * Poll Besu RPC with JSON-RPC request
 */
function pollBesuRPC(timeout) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const poll = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        reject(new Error(`Besu RPC did not respond within ${timeout}ms`));
        return;
      }

      const postData = JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
        id: 1
      });

      const options = {
        hostname: 'localhost',
        port: 8545,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000
      };

      const request = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.result !== undefined) {
              resolve();
            } else {
              setTimeout(poll, 1000);
            }
          } catch {
            setTimeout(poll, 1000);
          }
        });
      });

      request.on('error', () => {
        setTimeout(poll, 1000);
      });

      request.on('timeout', () => {
        request.destroy();
        setTimeout(poll, 1000);
      });

      request.write(postData);
      request.end();
    };

    poll();
  });
}

/**
 * Spawn a child process with prefixed output
 */
function spawnWithPrefix(command, args, prefix, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true
    });

    proc.stdout.on('data', (data) => {
      process.stdout.write(`[${prefix}] ${data}`);
    });

    proc.stderr.on('data', (data) => {
      process.stderr.write(`[${prefix}] ${data}`);
    });

    proc.on('error', reject);
    resolve(proc);
  });
}

/**
 * Validate middleware environment configuration
 */
function validateMiddlewareEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '../middleware/.env');
  
  if (!fs.existsSync(envPath)) {
    console.warn('⚠️  Warning: middleware/.env not found. Using .env.example as template.');
    return;
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  
  // Check for line breaks in critical variables
  if (envContent.includes('MIDDLEWARE_API_KEYS=')) {
    const apiKeysMatch = envContent.match(/MIDDLEWARE_API_KEYS=([^\n]*(?:\n[^\n]*)*)/);
    if (apiKeysMatch && apiKeysMatch[0].includes('\n') && !apiKeysMatch[0].includes('\\n')) {
      console.warn('⚠️  Warning: MIDDLEWARE_API_KEYS appears to have line breaks. Ensure all config values are on single lines.');
    }
  }
  
  if (!envContent.includes('MIDDLEWARE_API_KEYS=')) {
    console.warn('⚠️  Warning: MIDDLEWARE_API_KEYS not found in middleware/.env');
  }
}

/**
 * Main startup sequence
 */
async function main() {
  console.log('🚀 Starting TSS stack...\n');

  try {
    // Validate middleware environment
    validateMiddlewareEnv();
    
    // Step 1: Start Besu network
    console.log('📦 Starting Besu network...');
    execSync('docker compose up -d', { stdio: 'inherit' });
    console.log('✓ Docker compose started\n');

    // Step 2: Wait for Besu RPC to be ready
    console.log('⏳ Waiting for Besu RPC to be ready...');
    await pollBesuRPC(BESU_TIMEOUT);
    console.log('✓ Besu network running on :8545\n');

    // Step 3: Start middleware
    console.log('📦 Starting middleware...');
    middlewareProcess = await spawnWithPrefix(
      'node',
      ['middleware/src/server.js'],
      'middleware',
      process.cwd()
    );
    console.log('✓ Middleware process started\n');

    // Step 4: Wait for middleware health
    console.log('⏳ Waiting for middleware health check...');
    await pollEndpoint(MIDDLEWARE_HEALTH_URL, MIDDLEWARE_TIMEOUT, 'Middleware');
    console.log('✓ Middleware running on :3000\n');

    // Step 5: Start frontend dev server
    console.log('📦 Starting frontend dev server...');
    frontendProcess = await spawnWithPrefix(
      'npm',
      ['run', 'dev'],
      'frontend',
      'frontend'
    );
    console.log('✓ Frontend process started\n');

    // Step 6: Print summary
    console.log('═══════════════════════════════════════════');
    console.log('✓ Besu network running on :8545');
    console.log('✓ Middleware running on :3000');
    console.log('✓ Frontend running on :5173');
    console.log('═══════════════════════════════════════════\n');
    console.log('Press Ctrl+C to stop all services\n');
  } catch (error) {
    console.error('❌ Error during startup:', error.message);
    cleanup();
    process.exit(1);
  }
}

/**
 * Cleanup function
 */
function cleanup() {
  console.log('\n🛑 Shutting down services...');

  // Kill middleware process
  if (middlewareProcess) {
    console.log('Stopping middleware...');
    middlewareProcess.kill('SIGTERM');
  }

  // Kill frontend process
  if (frontendProcess) {
    console.log('Stopping frontend...');
    frontendProcess.kill('SIGTERM');
  }

  // Wait a bit for graceful shutdown, then force kill if needed
  setTimeout(() => {
    if (middlewareProcess && !middlewareProcess.killed) {
      middlewareProcess.kill('SIGKILL');
    }
    if (frontendProcess && !frontendProcess.killed) {
      frontendProcess.kill('SIGKILL');
    }

    // Stop Docker Compose
    console.log('Stopping Docker Compose...');
    try {
      execSync('docker compose down', { stdio: 'inherit' });
    } catch (error) {
      console.error('Error stopping Docker Compose:', error.message);
    }

    console.log('✓ All services stopped');
    process.exit(0);
  }, 2000);
}

// Handle Ctrl+C
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the application
main();
