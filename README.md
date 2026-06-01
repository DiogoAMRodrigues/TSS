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
├── scripts/            # deploy.js, reset-network.ps1, smoke-eidas.js, deploy-vm.js, vm-*.js
├── test/               # Hardhat unit tests
└── docs/               # Architecture documentation
```

## Quick Start (everything at once)
```bash
npm start ob    # Start with Order Book trading engine
npm start amm   # Start with AMM trading engine
npm start       # Defaults to Order Book
```
Starts Besu network, deploys contracts, middleware, and frontend with the selected trading engine. Ctrl+C stops everything.

You can also use the shorthand scripts:
```bash
npm run start:ob    # Order Book mode
npm run start:amm   # AMM mode
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

## KYC Middleware (eIDAS)

A middleware under `middleware/` handles eIDAS/KYC and writes decisions to `Identity.sol`.
It supports two interchangeable providers selected via `EIDAS_PROVIDER`:

- `simulated` (default) — local stub for development and tests.
- `real` — SAML 2.0 integration with Portugal's **AMA Autenticação.gov** preprod IdP.

See [VM Deployment (INESC cluster + Real eIDAS)](#vm-deployment-inesc-cluster--real-eidas) for the SAML setup and one-shot deploy script.

### Middleware setup
1. Deploy contracts:
	```bash
	npx hardhat run scripts/deploy.js --network besu
	```
2. Generate middleware env from deployment output:
	```bash
	npm run middleware:prepare-env
	```

### Middleware configuration

The middleware requires a local `.env` file with:
- **OPERATOR_PRIVATE_KEY_FILE**: Path to a file containing the operator's private key (hex format). This is used to sign on-chain transactions (attestations, whitelisting).
- **MIDDLEWARE_API_KEYS**: Space-separated key:role pairs for API authentication. Format: `key1:ROLE1;key2:ROLE2`. Roles are CLIENT, OPERATOR, REGULATOR, ADMIN.

**Setup:**
1. Copy `middleware/.env.example` to `middleware/.env`:
	```bash
	cp middleware/.env.example middleware/.env
	```
2. Create `middleware/.operator-private-key` with your operator's private key (hex):
	```bash
	echo "0x1ca60577f0b6dbf9ebddeb330615c25824f2e458eed044b0abc3ac954eb1f3db" > middleware/.operator-private-key
	```
3. Configure `MIDDLEWARE_API_KEYS` in `middleware/.env` (each key on a single line, no line breaks):
	```
	MIDDLEWARE_API_KEYS=operator-key:OPERATOR;client-key:CLIENT;regulator-key:REGULATOR
	```

**Important:** Ensure the `MIDDLEWARE_API_KEYS` line has no line breaks or wrapping. If you see the line split across multiple lines in your editor, the middleware will fail to parse the keys and reject all API requests with 401 errors.

**Git:** Both `middleware/.env` and `middleware/.operator-private-key` are gitignored to prevent accidental secret leaks. Each developer must set these up locally.

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
2. Create env file from example:
	```bash
	cp .env.example .env
	```
	Configure `VITE_API_URL` and `VITE_API_KEY` to match your middleware setup. Example:
	```
	VITE_API_URL=http://localhost:3000
	VITE_API_KEY=operator-key
	VITE_DEBUG=true
	```
	**Note:** `VITE_DEBUG=true` logs all API calls and responses to the browser console for troubleshooting.

3. Start dev server (requires middleware running on port 3000):
	```bash
	npm run dev
	```
4. Open `http://localhost:5173`

### Debugging
Set `VITE_DEBUG=true` in `frontend/.env` and open the browser console (F12) to see API calls, keys used, and response statuses.

### Features
- **User view**: Connect wallet, start KYC, sign challenge with MetaMask, then either:
  - **Continue with Cartão de Cidadão (eIDAS)** — redirects to AMA Autenticação.gov, log in with real CC + PIN (or Chave Móvel Digital), AMA POSTs the SAML response back to the middleware, wallet is whitelisted on chain.
  - **Use simulated KYC** (dev only) — bypasses AMA, signature alone is enough.
- View status / role / expiry, reverify when attestation expires.
- **Admin view**: Revoke users, trigger reconciliation, browse audit log, look up user state.

### Testing real eIDAS end-to-end
1. Make sure the full stack is up: `npm run deploy:vm` (docker, contracts, tunnel, VM middleware).
2. Point the frontend at the public middleware in `frontend/.env`:
   ```
   VITE_API_URL=https://tss.dpss.inesc-id.pt
   VITE_API_KEY=client-key
   ```
   (localhost won't work — AMA can't reach it for the callback.)
3. `cd frontend && npm run dev` → `http://localhost:5173`.
4. Connect MetaMask (network `IST_Test`, chainId `0x539`).
5. Start KYC → sign challenge → click **Continue with Cartão de Cidadão (eIDAS)**.
6. AMA login: insert CC, enter PIN, **Autorizar** the requested attributes.
7. Tab redirects back to `/api/kyc/eidas/callback` — middleware whitelists wallet on chain.
8. Verify on chain:
   ```powershell
   npx hardhat console --network besu
   ```
   ```js
   const id = await ethers.getContractAt("Identity", "0x7aCDC22Fe83cB0CD65F421398f9968Ac1D7Fd425");
   await id.isWhitelisted("<your wallet>")  // → true
   ```

## VM Deployment (INESC cluster + Real eIDAS)

The middleware is deployed on the INESC-ID DPSS VM and exposed publicly at
`https://tss.dpss.inesc-id.pt`, so AMA Autenticação.gov can callback into it
during real eIDAS / SAML 2.0 KYC flows. The blockchain stays on the laptop
and is bridged to the VM via a reverse SSH tunnel.

### Architecture
```
[ AMA / autenticação.gov IdP (preprod) ]
        │  SAML 2.0 over HTTPS
        ▼
[ DPSS nginx → https://tss.dpss.inesc-id.pt ]   (Let's Encrypt, managed by DPSS)
        │  HTTP :80
        ▼
[ VM 10.16.144.70 — Apache2 reverse proxy / → 127.0.0.1:3000 ]
        │
        ▼
[ middleware on VM  127.0.0.1:3000 ]
        │  JSON-RPC via SSH reverse tunnel  127.0.0.1:8545 → laptop:8545
        ▼
[ Hyperledger Besu 4-node IBFT (docker)  on laptop  127.0.0.1:8545 ]
```

Why the split: AMA only needs to reach the **middleware** (callback URL); the
chain doesn't need to be public. Laptop runs Docker + Besu (much simpler than
installing Besu on the VM); reverse SSH tunnel bridges them. Trade-off: when
the laptop sleeps or the tunnel drops, the middleware loses chain access —
fine for thesis demos, not 24/7. Re-run `npm run deploy:vm` to restore it.

### One-shot deploy
From a clean, pushed working tree:
```bash
npm run deploy:vm
```
Sequence (`scripts/deploy-vm.js`):
1. **Pre-flight** — refuse to deploy if the local tree is dirty or local HEAD ≠ `origin/main` (override with `--no-verify-clean`).
2. **`docker compose up -d`** — bring up the 4-node Besu network on the laptop and wait for `eth_blockNumber` on `127.0.0.1:8545`.
3. **Deploy contracts** — runs `scripts/deploy.js --network besu`, but skips if `scripts/check-deployment.js` reports `VALID` (override with `--force-deploy`).
4. **Patch `middleware/.env`** — auto-seeds `IDENTITY_ADDRESS`, `RPC_URL=http://127.0.0.1:8545`, and the full eIDAS SAML block (entry point, SP entity, ACS, SLO, cert paths, requested attributes, clock skew) if missing.
5. **`scp -r`** middleware + `package.json` + `package-lock.json` + `artifacts/` + `deployments/besu.json` to `~/` on the VM.
6. **SSH install gate** — on the VM: kill anything on port `:8545` and `:3000` (`fuser -k`), `npm install --omit=dev` if the lockfile changed or `node_modules/ethers` is missing, then `setsid nohup node middleware/src/server.js > ~/middleware.log 2>&1 &`. Verifies via `ss -tln | grep ':3000 '`.
7. **Spawn reverse SSH tunnel** in a separate cmd window (`-N -R 8545:127.0.0.1:8545`) — survives script exit; close the window manually when done.
8. **Poll** `https://tss.dpss.inesc-id.pt/health` until 2xx, then print log tail.

Expect ~6 password prompts per full run (3 SSH/SCP pairs with ProxyJump).

Flags:
- `--skip-deploy` — don't redeploy contracts even if `check-deployment` says INVALID.
- `--force-deploy` — redeploy contracts even when chain state is VALID.
- `--skip-install` — don't `npm install` on the VM even if the lockfile changed.
- `--skip-tunnel` — don't spawn a new tunnel window (assumes one is already up).
- `--no-verify-clean` — bypass the local-clean / pushed-to-origin check.
- `npm run X` swallows flags. To pass them, use `npm run deploy:vm -- --skip-deploy`.

### Other VM commands
```bash
npm run vm:check               # public /health probe + remote port :3000 check
npm run vm:check -- --logs     # also print last 50 log lines
npm run vm:logs                # tail -f middleware.log on VM (Ctrl+C to stop)
npm run vm:logs 200            # last 200 lines, then follow
npm run vm:restart             # stop + relaunch middleware (no git pull, no scp)
npm run smoke:eidas            # local AuthnRequest structural smoke test (does NOT contact AMA)
```

### SSH config
Scripts default to `D:\Main\Documents\Academic\IST\TESE\cluster_configuration_ist1112192\config`.
Override with environment variables:
```
set VM_SSH_CONFIG=path\to\config
set VM_SSH_USER=ist1112192
set VM_SSH_HOST=10.16.144.70
set VM_SSH_JUMP=inesc-headnode
```
Other overrides (`VM_REPO_DIR`, `VM_RUN_DIR`, `VM_START_CMD`,
`VM_PUBLIC_HEALTH_URL`, `vmProcessPattern`, …) live in `scripts/vm-config.js`.

### Real eIDAS — SAML 2.0 to AMA Autenticação.gov

The `real` eIDAS provider (`middleware/src/providers/realEidasProvider.js`)
speaks SAML 2.0 directly to Portugal's
Autenticação.gov preprod IdP (`https://preprod.autenticacao.gov.pt/fa/Default.aspx`).
Selected via `EIDAS_PROVIDER=real`. Default is `simulated` (local stub for tests).

**End-to-end browser flow:**
```
wallet  --POST /api/kyc/request---------------------------->  middleware
                                                              (returns challenge, 5-min TTL)
wallet  --MetaMask personal_sign-------------------------->  user signs challenge
browser --GET  /api/kyc/eidas/start?apiKey=&walletAddress=&signature=&requestedRole=
                                                              middleware
                                                              (returns auto-submit form)
browser --POST------------------------------------------->   AMA login (CC + PIN, or CMD)
AMA     --POST /api/kyc/eidas/callback------------------->   middleware
                                                              --tx (via tunnel)-->  Identity.whitelist()
```

`RelayState` carries the wallet address across the redirect so the middleware
binds the AMA-issued attributes to the right address on callback.

`/api/kyc/eidas/start` accepts the API key as either an `x-api-key` header
**or** an `?apiKey=` query parameter (the browser URL bar can't set headers).
Defense-in-depth is preserved: the wallet's signature on the challenge is the
real auth gate.

**Required `.env` keys** (`patchMiddlewareEnv()` auto-seeds these on every deploy):
```
EIDAS_PROVIDER=real
EIDAS_IDP_ENTRY_POINT=https://preprod.autenticacao.gov.pt/fa/Default.aspx
EIDAS_IDP_ISSUER=https://preprod.autenticacao.gov.pt
EIDAS_SP_ENTITY_ID=https://tss.dpss.inesc-id.pt
EIDAS_SP_PROVIDER_NAME=TSS - Instituto Superior Tecnico
EIDAS_SP_ACS_URL=https://tss.dpss.inesc-id.pt/api/kyc/eidas/callback
EIDAS_SP_SLO_URL=https://tss.dpss.inesc-id.pt/logout
EIDAS_SP_CERT_PATH=middleware/certs/tss-saml-leaf.crt
EIDAS_SP_KEY_PATH=middleware/certs/tss-saml.key
EIDAS_IDP_CERT_PATH=middleware/certs/ama-preprod-ca.crt
EIDAS_REQUESTED_ATTRIBUTES=NIC,NomeCompleto,NomeProprio,NomeApelido,DataNascimento,CorreioElectronico
EIDAS_CLOCK_SKEW_SECONDS=30
```

**SAML certs** (gitignored, must be present on the VM under `middleware/certs/`):
- `tss-saml.key` — RSA 2048 private key, generated on the VM, chmod 600, **never** leaves the VM.
- `tss-saml-leaf.crt` — AMA-signed SP cert (Issuer `CN=saml.preprod.autenticacao.gov.pt, O=AMA`, Subject `tss.dpss.inesc-id.pt`).
- `ama-preprod-ca.crt` — AMA's preprod IdP cert (validates incoming SAML responses).

To verify cert ↔ key match on the VM:
```bash
openssl x509 -in middleware/certs/tss-saml-leaf.crt -noout -modulus | openssl md5
openssl rsa  -in middleware/certs/tss-saml.key       -noout -modulus | openssl md5
# both md5 hashes must match
```

**AMA SP registration** is handled by Rui Martinho (`rui.martinho@arte.gov.pt`,
ARTE/AMA). One-time process: send CSR + SP form → AMA signs cert → place
`tss-saml-leaf.crt` + `ama-preprod-ca.crt` on the VM → AMA flips config live.

**Smoke test** — builds and signs an AuthnRequest locally without contacting
AMA, then runs structural assertions (signature, embedded cert subject,
`fa:RequestedAttributes` extension, etc.):
```bash
npm run smoke:eidas
```
Output written to `scripts/smoke-out/authn-request.xml`. Exits non-zero on failure.

### Hard constraints
1. **`localhost` on Windows resolves to IPv6 (`::1`) first.** Besu binds IPv4 — always use `127.0.0.1` explicitly.
2. **`package.json` lives at the TSS root**, not in `middleware/`. On the VM, `node_modules/` ends up in `~/`, and `node middleware/src/server.js` must be run from `~` so `.env` relative paths resolve.
3. **`ethers` is a runtime dependency** (not devDependency) — `--omit=dev` would otherwise skip it and the middleware crashes on import.
4. **No sudo on the cluster jump host** (`inesc-headnode`). It's gateway-only. All compute happens on the VM `10.16.144.70`.
5. **Tunnel must be up before middleware accepts KYC requests.** The middleware uses a lazy `JsonRpcProvider`, so it starts fine without the tunnel, but any `/api/kyc/*` call that touches the chain will fail until the tunnel is restored.

### Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `curl: (52) Empty reply` from local besu | Besu still bootstrapping | Wait 30s; `docker compose logs --tail 20 node1` should show `Imported #N` |
| `npm run deploy:vm` exits with `4294967295` | Self-killed via `pkill -f` argv match (legacy bug) | Already fixed: deploy script uses port-based `fuser -k 8545/tcp; fuser -k 3000/tcp` |
| Middleware `Cannot find module 'ethers'` on VM | `--omit=dev` skipped a devDependency | Already fixed: `ethers` moved to `dependencies`. Re-run deploy to refresh `node_modules` |
| `/api/kyc/eidas/start` returns `Missing x-api-key` in browser | Browser URL bar can't set headers | Use `?apiKey=client-key` query param (already supported) |
| `/api/kyc/eidas/callback` 5xx | SP cert ↔ key mismatch, or AMA cert path wrong | Verify modulus md5 (above); check `EIDAS_*_CERT_PATH` resolves under `middleware/certs/` on the VM |
| `/health` 2xx but `POST /api/kyc/request` hangs | Reverse tunnel dropped (laptop slept, SSH timeout) | Re-run `npm run deploy:vm` (or just leave the cmd window open and re-trigger SSH) |
| PowerShell `--data '{...}'` collapses to `{}` | PowerShell quoting | Write the JSON to a temp file and use `curl --data-binary "@body.json"` |
| `Cannot GET /` from `https://tss.dpss.inesc-id.pt/` | No UI route on the middleware | Expected. Hit `/health` or the `/api/...` endpoints |

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
- [x] May - KYC/eIDAS integration (simulated + real SAML 2.0 to AMA Autenticação.gov), React frontend, VM deployment on INESC DPSS cluster (`https://tss.dpss.inesc-id.pt`)
- [ ] June - Evaluation, performance testing, paper, thesis writeup
- [ ] July - Dissertation writeup

## TODO this month
- End-to-end testing of the full stack (real eIDAS flow + DvP scenarios)
- Performance / evaluation measurements for thesis
- Paper draft
- Dissertation writeup