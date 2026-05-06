#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
function spawnWithPrefix(command, args, prefix, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, ...extraEnv }
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
  // Parse trading mode argument
  const modeArg = process.argv[2];
  const validModes = ['ob', 'amm'];
  const tradingMode = validModes.includes(modeArg) ? modeArg : 'ob';
  console.log(`📊 Trading mode: ${tradingMode === 'ob' ? 'Order Book' : 'AMM'}\n`);

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

    // Step 3: Deploy smart contracts (skip if already deployed and valid)
    const deploymentsPath = path.join(__dirname, '..', 'deployments', 'besu.json');
    let needsDeploy = true;

    if (fs.existsSync(deploymentsPath)) {
      // Check if existing deployment is still valid (contracts have code on-chain)
      try {
        const existing = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
        const checkAddr = existing.contracts.Identity;
        const checkResult = execSync(
          `npx hardhat run --network besu scripts/check-deployment.js`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        if (checkResult.trim() === 'VALID') {
          needsDeploy = false;
          console.log('✓ Existing deployment still valid, skipping redeploy\n');
        }
      } catch {
        // If check fails, redeploy
      }
    }

    if (needsDeploy) {
      console.log('📦 Deploying smart contracts...');
      execSync('npx hardhat run scripts/deploy.js --network besu', { stdio: 'inherit' });
      console.log('✓ Contracts deployed\n');
    }

    // Step 4: Write frontend .env with deployed addresses and update middleware Identity address
    console.log('📝 Configuring environments...');
    const deploymentsPath = path.join(__dirname, '..', 'deployments', 'besu.json');
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'));
    const c = deployments.contracts;

    // Read middleware .env to extract the operator API key
    const middlewareEnvPath = path.join(__dirname, '..', 'middleware', '.env');
    let operatorApiKey = 'operator-key'; // default from .env.example
    if (fs.existsSync(middlewareEnvPath)) {
      const mwEnv = fs.readFileSync(middlewareEnvPath, 'utf8');
      // Extract operator key from MIDDLEWARE_API_KEYS (format: key:ROLE;key2:ROLE)
      const apiKeysMatch = mwEnv.match(/MIDDLEWARE_API_KEYS=([^\n]*)/);
      if (apiKeysMatch) {
        const pairs = apiKeysMatch[1].split(';');
        for (const pair of pairs) {
          const [key, role] = pair.split(':');
          if (role && role.toUpperCase().includes('OPERATOR')) {
            operatorApiKey = key;
            break;
          }
        }
      }
      // Update IDENTITY_ADDRESS in middleware .env with deployed address
      const updatedMwEnv = mwEnv.replace(
        /IDENTITY_ADDRESS=.*/,
        `IDENTITY_ADDRESS=${c.Identity}`
      );
      if (updatedMwEnv !== mwEnv) {
        fs.writeFileSync(middlewareEnvPath, updatedMwEnv);
        console.log('  ✓ Updated middleware IDENTITY_ADDRESS');
      }
    }

    const frontendEnvPath = path.join(__dirname, '..', 'frontend', '.env');
    const frontendEnv = [
      'VITE_API_URL=http://localhost:3000',
      `VITE_API_KEY=${operatorApiKey}`,
      `VITE_CASH_TOKEN_ADDRESS=${c.CashToken}`,
      `VITE_SECURITIES_TOKEN_ADDRESS=${c.SecuritiesToken}`,
      `VITE_ORDERBOOK_ADDRESS=${c.OrderBook}`,
      `VITE_AMM_ADDRESS=${c.AMM}`,
      `VITE_IDENTITY_ADDRESS=${c.Identity}`,
      `VITE_TRADING_MODE=${tradingMode}`,
      'VITE_DEBUG=false',
    ].join('\n');
    fs.writeFileSync(frontendEnvPath, frontendEnv + '\n');
    console.log('  ✓ Frontend .env configured with contract addresses\n');

    // Step 5: Start middleware
    console.log('📦 Starting middleware...');
    middlewareProcess = await spawnWithPrefix(
      'node',
      ['middleware/src/server.js'],
      'middleware',
      process.cwd()
    );
    console.log('✓ Middleware process started\n');

    // Step 6: Wait for middleware health
    console.log('⏳ Waiting for middleware health check...');
    await pollEndpoint(MIDDLEWARE_HEALTH_URL, MIDDLEWARE_TIMEOUT, 'Middleware');
    console.log('✓ Middleware running on :3000\n');

    // Step 7: Start frontend dev server
    console.log('📦 Starting frontend dev server...');
    frontendProcess = await spawnWithPrefix(
      'npm',
      ['run', 'dev'],
      'frontend',
      'frontend',
      { VITE_TRADING_MODE: tradingMode }
    );
    console.log('✓ Frontend process started\n');

    // Step 8: Print summary
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
