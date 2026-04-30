# TSS - Trading and Settlement System

A DLT-based Trading and Settlement System built on Hyperledger Besu with IBFT 2.0 consensus, compliant with EU MiCA and DLT Pilot Regime regulations.

## Prerequisites
- Java 22+ (`C:\Program Files\Java\jdk-22`)
- Docker Desktop
- Node.js 24+
- Hyperledger Besu 26.1.0 (`C:\Program Files\besu\bin`)

## Project Structure
```
TSS/
├── contracts/
│   ├── interfaces/     # IAccessControl, ITokenTransfer, IDvPTrigger, IMatchingEngine, IRegistry
│   ├── identity/       # Identity.sol - KYC & role-based access control
│   ├── tokens/         # SecuritiesToken.sol, CashToken.sol
│   ├── trading/        # OrderBook.sol, AMM.sol - IMatchingEngine implementations
│   ├── settlement/     # Settlement.sol - atomic DvP
│   └── registry/       # Registry.sol - asset directory
├── networkFiles/       # Generated validator keys and genesis (gitignored)
├── node1-4/            # Validator node data (keys gitignored)
├── scripts/            # deploy.js, reset-network.ps1
├── test/               # Hardhat unit tests
└── docs/               # Architecture documentation
```

## Quick Start (everything at once)
```bash
npm start
```
Starts Besu network, middleware, and frontend. Ctrl+C stops everything.

## Network Setup

### First time / full reset (regenerates keys and genesis)
Only needed if you need to wipe the network from scratch. Stops containers, deletes node data, regenerates keys, and updates docker-compose automatically.
```powershell
docker compose down
.\scripts\reset-network.ps1
```

### Start the 4-node IBFT 2.0 network
```bash
docker compose up
```
Wait until you see `Imported #1`, `#2`, etc. across all 4 nodes before doing anything else.
Note: Node1 has a static IP (172.16.239.11) so nodes 2, 3 and 4 can use it as bootnode.

### Verify network is running
```bash
curl -X POST --data "{\"jsonrpc\":\"2.0\",\"method\":\"ibft_getValidatorsByBlockNumber\",\"params\":[\"latest\"],\"id\":1}" http://localhost:8545
```
Should return all 4 validator addresses.

## Smart Contracts

### Architecture
The system uses a generic plugin architecture where any matching mechanism can plug into the compliant settlement infrastructure by implementing `IMatchingEngine`.

- **Identity.sol** - KYC whitelisting and role-based access (TRADER, ISSUER, OPERATOR, REGULATOR). All transfers enforce whitelisting.
- **SecuritiesToken.sol** - ERC-20 tokenized securities. Transfers restricted to whitelisted addresses.
- **CashToken.sol** - ERC-20 tokenized EUR for DvP cash leg.
- **Registry.sol** - Tracks all deployed compliant token contracts.
- **OrderBook.sol** - On-chain order book implementing `IMatchingEngine`. Price-time priority matching. Triggers DvP on match.
- **AMM.sol** - Constant-product automated market maker implementing `IMatchingEngine`. Uses the same settlement/compliance layer with pool-based execution.
- **Settlement.sol** - Atomic DvP settlement. Both token transfers succeed or both revert. Generic - works with any `IMatchingEngine` implementation.

### Deployment order
Identity → Registry → Settlement → OrderBook/AMM → SecuritiesToken → CashToken → Register tokens

### Plugin evaluation
The thesis now compares the matching plugins directly with equivalent scenarios to show that the same compliance and settlement backbone supports different execution models.

- `test/PluginComparison.test.js` runs parity scenarios across OrderBook and AMM.
- The comparison covers successful settlement, authorization failure, allowance failure, whitelist failure, registry deactivation, and paused settlement.
- The suite also records gas and transaction-count evidence for equivalent paths.

### Identity re-verification modes
The identity contract now supports user-selectable re-verification behavior after attestation expiry.

- Easy re-verification (default): operator can refresh the user attestation on-chain by calling `updateAttestation(user, newExpiry)`.
- Full re-verification required: user opts out of easy refresh, and then `updateAttestation` reverts for that user. In this mode, the provider must run the full off-chain KYC flow again and then call `whitelist(user, role)`.

User preference control:
- User enables/disables easy refresh with `setReverificationPreference(bool easyReverification)`.
- Current preference can be read with `prefersEasyReverification(address user)`.

Suggested operational flow:
- During onboarding, ask the user which mode they want.
- If easy mode: keep using attestation refresh (`updateAttestation`) when KYC evidence is renewed.
- If strict mode: re-run full KYC and re-whitelist on each renewal cycle.

## Hardhat

### Compile contracts
```bash
npx hardhat compile
```

### Run tests (local)
```bash
npx hardhat test
```

### Run tests (against Besu network)
Requires the network to be running (`docker compose up` in a separate terminal).  
```bash
npx hardhat test --network besu
```

### Deploy to Besu network
Requires the network to be running (`docker compose up` in a separate terminal).
```bash
npx hardhat run scripts/deploy.js --network besu
```

## Typical workflow

**Normal session** (network already set up, just starting it):
```bash
# Terminal 1 - start network
docker compose up

# Terminal 2 - run tests or deploy
npx hardhat test --network besu
npx hardhat run scripts/deploy.js --network besu
```

**Full reset** (something went wrong, or starting fresh):
```powershell
# Terminal 1
docker compose down
.\scripts\reset-network.ps1
docker compose up

# Terminal 2
npx hardhat test --network besu
```

## KYC Middleware (Simulated eIDAS)

A prototype middleware is available under `middleware/` to simulate eIDAS/KYC and write decisions to `Identity.sol`.

### Middleware setup
1. Deploy contracts:
	```bash
	npx hardhat run scripts/deploy.js --network besu
	```
2. Generate middleware env from deployment output:
	```bash
	npm run middleware:prepare-env
	```
3. Start the API:
	```bash
	npm run middleware:start
	```
4. Run middleware tests:
	```bash
	npm run test:middleware
	```
5. Run chain-backed integration tests:
	```bash
	# Fast full pass without Besu contracts
	npm run test:all

	# Besu-only pass (contracts on Besu + Besu middleware integration)
	npm run test:all:besu-only

	# Full matrix in one command (slowest: includes everything above)
	npm run test:all:besu

	# In-process local chain (Hardhat)
	npm run test:middleware:hardhat-chain

	# Check Besu test prerequisites (RPC, identity address, operator key)
	npm run test:middleware:besu-check

	# Live Besu chain (requires running network + deployed Identity)
	npm run test:middleware:besu-chain

	# Strict mode: fail instead of skip when Besu prerequisites are missing
	npm run test:middleware:besu-chain:strict
	```

The deployment script now stores addresses in `deployments/besu.json`, which is used to prefill `middleware/.env`.
See `middleware/README.md` for endpoints and request examples.

Security additions in middleware:
- API key authentication + role-based authorization.
- Rate limiting for request and verification endpoints.
- Persistent middleware state storage.
- Optional periodic/manual on-chain reconciliation endpoint.

Note: middleware protected endpoints require an `x-api-key` header.

## Frontend (React)

A React web interface under `frontend/` provides wallet connection (MetaMask), KYC verification flow, and an admin panel.

### Frontend setup
1. Install dependencies:
	```bash
	cd frontend
	npm install
	```
2. Copy env file:
	```bash
	cp .env.example .env
	```
3. Start dev server (requires middleware running on port 3000):
	```bash
	npm run dev
	```
4. Open `http://localhost:5173`

### Debugging
Set `VITE_DEBUG=true` in `frontend/.env` and open the browser console (F12) to see API calls, keys used, and response statuses.

### Features
- **User view**: Connect wallet, start KYC (sign challenge via MetaMask), view status/role/expiry, reverify
- **Admin view**: Revoke users, trigger reconciliation, browse audit log, look up user state

## Architecture
4-layer architecture:
- **Layer 1**: Permissioned Blockchain (Hyperledger Besu, IBFT 2.0)
- **Layer 2**: Smart Contracts (Identity, Tokens, Order Book, Settlement, Registry)
- **Layer 3**: KYC/Identity Layer (eIDAS-compatible, off-chain)
- **Layer 4**: User & Regulator Interfaces (React, MetaMask, Observer Node)

## Progress
- [x] February - Besu network setup, Hardhat toolchain
- [x] March - Identity, SecuritiesToken, CashToken, Registry
- [x] April - OrderBook, Settlement, AMM, end-to-end DvP flow tested
- [x] May - KYC/eIDAS integration, React frontend
- [ ] June - Evaluation and performance testing and thesis writeup support
- [ ] July - Dissertation writeup

## TODO this month
- Start looking into KYC/eIDAS -> do a middleware that simulates it for now, MAYBE later make the actual one with eIDAS