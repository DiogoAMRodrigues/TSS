# TSS KYC Middleware (Simulated eIDAS)

This middleware simulates an eIDAS/KYC provider, verifies wallet ownership by challenge signature, and writes access-control decisions to `Identity.sol`.

## What it does

- Receives KYC requests for wallet addresses.
- Verifies wallet ownership via signed challenge.
- Runs simulated identity checks.
- Assigns a role (`TRADER`, `ISSUER`, `OPERATOR`, `REGULATOR`).
- Calls on-chain `whitelist(...)` as OPERATOR.
- Handles reverification:
  - Easy mode users: `updateAttestation(...)`
  - Strict mode users: full simulated check + `whitelist(...)` again
- Enforces API-key authentication and role-based endpoint authorization.
- Enforces rate limits for abuse resistance.
- Persists middleware state to disk.
- Supports on-chain event reconciliation from `Identity` events.

## Setup

1. Ensure your Besu network is running.
2. Deploy contracts (or reuse an existing deployment).
3. Create middleware env file:

   - Copy `middleware/.env.example` to `middleware/.env`
   - Fill `IDENTITY_ADDRESS`
   - Fill `OPERATOR_PRIVATE_KEY` (must be an address with OPERATOR role in `Identity`)

4. Start middleware:

```bash
npm run middleware:start
```

## Security configuration

- Configure API keys and roles with `MIDDLEWARE_API_KEYS`.
- Turn auth on/off with `MIDDLEWARE_AUTH_ENABLED`.
- Configure rate limiting with `MIDDLEWARE_RATE_LIMIT_ENABLED` and `RATE_LIMIT_*` values.
- Protect production from known dev keys by keeping `ALLOW_DEV_KEYS=false`.

## Run middleware tests

```bash
npm run test:middleware
```

## Run chain-backed integration tests

```bash
# Fast full pass without Besu contracts
npm run test:all

# Besu-only pass (contracts on Besu + Besu middleware integration)
npm run test:all:besu-only

# Full matrix in one command (slowest: includes everything above)
npm run test:all:besu

# In-process local chain (Hardhat)
npm run test:middleware:hardhat-chain

# Check Besu prerequisites
npm run test:middleware:besu-check

# Live Besu chain (network + deployment required)
npm run test:middleware:besu-chain

# Strict mode: fail when Besu prerequisites are missing
npm run test:middleware:besu-chain:strict
```

For the Besu test, the runner looks for Identity address in this order:
- `BESU_IDENTITY_ADDRESS`
- `IDENTITY_ADDRESS`
- `deployments/besu.json`

## API

Base path: `/api/kyc`

Protected endpoints require `x-api-key` header (except health endpoints).

- `GET /health`
- `POST /request`
  - Body: `{ "walletAddress": "0x...", "requestedRole": "TRADER", "identityData": { "identifier": "abc123" } }`
- `POST /verify`
  - Body: `{ "walletAddress": "0x...", "signature": "0x...", "attestationDays": 90 }`
- `POST /reverify`
  - Body: `{ "walletAddress": "0x...", "requestedRole": "TRADER", "identityData": { "identifier": "abc123" } }`
- `POST /revoke`
  - Body: `{ "walletAddress": "0x...", "reason": "manual_revoke" }`
- `GET /users/:walletAddress`
- `GET /audit`
- `POST /reconcile`

## Notes

- Middleware state is persisted to disk (`STORE_PERSIST_FILE`) unless disabled.
- On-chain `Identity` state remains persisted on the network.
