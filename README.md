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
├── contracts/          # Solidity smart contracts
│   ├── interfaces/     # Contract interfaces
│   ├── identity/       # Identity & Whitelisting
│   ├── tokens/         # ERC-20, ERC-1155, Cash Token
│   ├── trading/        # Order Book & Matching
│   ├── settlement/     # DvP Settlement
│   └── registry/       # Asset Registry
├── networkFiles/       # Generated validator keys and genesis (gitignored)
├── node1-4/            # Validator node data (keys gitignored)
├── scripts/            # Deployment scripts
├── test/               # Hardhat tests
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

## Hardhat

### Compile contracts
```bash
npx hardhat compile
```

### Run tests
```bash
npx hardhat test
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



# TODO:
-Start implementing the actual Solidity contracts (Interfaces)