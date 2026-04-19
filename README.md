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
│   ├── trading/        # OrderBook.sol - IMatchingEngine implementation
│   ├── settlement/     # Settlement.sol - atomic DvP
│   └── registry/       # Registry.sol - asset directory
├── networkFiles/       # Generated validator keys and genesis (gitignored)
├── node1-4/            # Validator node data (keys gitignored)
├── scripts/            # deploy.js, reset-network.ps1
├── test/               # Hardhat unit tests
└── docs/               # Architecture documentation
```

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
- **Settlement.sol** - Atomic DvP settlement. Both token transfers succeed or both revert. Generic - works with any `IMatchingEngine` implementation.

### Deployment order
Identity → Registry → Settlement → OrderBook → SecuritiesToken → CashToken → Register tokens

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
Before running, comment out the two lines marked `// LOCAL ONLY` in the Expiry Behavior tests in `test/Identity.test.js`.
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

## Architecture
4-layer architecture:
- **Layer 1**: Permissioned Blockchain (Hyperledger Besu, IBFT 2.0)
- **Layer 2**: Smart Contracts (Identity, Tokens, Order Book, Settlement, Registry)
- **Layer 3**: KYC/Identity Layer (eIDAS-compatible, off-chain)
- **Layer 4**: User & Regulator Interfaces (React, MetaMask, Observer Node)

## Progress
- [x] February - Besu network setup, Hardhat toolchain
- [x] March - Identity, SecuritiesToken, CashToken, Registry
- [x] April - OrderBook, Settlement, end-to-end DvP flow tested
- [ ] May - KYC/eIDAS integration, React frontend
- [ ] June - Evaluation and performance testing
- [ ] July - Dissertation writeup

## TODO this month
- Add contracts for trading: 
- Start looking into KYC/eIDAS -> do a middleware that simulates it for now, MAYBE later make the actual one with eIDAS