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
├── scripts/            # deploy.js
├── test/               # Hardhat unit tests
└── docs/               # Architecture documentation
```

## Network Setup

### Generate validator keys and genesis (already done)
```bash
besu operator generate-blockchain-config --config-file=ibftConfigFile.json --to=networkFiles --private-key-file-name=key
```

### Start the 4-node IBFT 2.0 network
```bash
docker compose up
```
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
Before running against Besu, in `test/Identity.test.js` comment out the two lines marked `// LOCAL ONLY` in the Expiry Behavior tests  
```bash
npx hardhat test --network besu
```

### Deploy to Besu network
```bash
npx hardhat run scripts/deploy.js --network besu
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
- Make the contracts run against Besu