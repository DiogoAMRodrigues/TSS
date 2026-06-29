# TSS Frontend (React + Vite)

The web interface for the TSS Trading and Settlement System. Provides MetaMask
wallet connection, the KYC verification flow (simulated or real eIDAS), a trading
interface (OrderBook and AMM), and an admin panel.

It talks to the KYC middleware (`../middleware`) over REST and to the chain via
MetaMask. See the root [`README.md`](../README.md) for the full stack and the
real eIDAS / VM deployment flow.

## Prerequisites

- Node.js 24+
- The middleware running (default `http://localhost:3000`)
- MetaMask, connected to the Besu network (`IST_Test`, chainId `0x539` / 1337)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create the env file from the example:
   ```bash
   cp .env.example .env
   ```
   Configure to match your middleware:
   ```
   VITE_API_URL=http://localhost:3000
   VITE_API_KEY=operator-key
   VITE_DEBUG=true
   ```
   `VITE_DEBUG=true` logs all API calls and responses to the browser console.
3. Start the dev server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:5173`.

For real eIDAS end-to-end testing against the public middleware, point
`VITE_API_URL` at `https://tss.dpss.inesc-id.pt` (localhost cannot receive the
AMA callback). Full steps are in the root README under
"Testing real eIDAS end-to-end".

## Structure

```
src/
├── App.jsx                # Root component with routing
├── main.jsx               # Entry point
├── components/            # Navbar, KycFlow, KycStatusCard, RevokeForm,
│                          # UserList, UserLookup, AuditLog
├── pages/                 # Dashboard, UserDashboard, AdminPanel, TradePage,
│                          # OrderBookPage, AMMPage, Portfolio
├── context/               # WalletContext (wallet connection state)
└── services/api.js        # REST client for the middleware
```

## Features

- **User view:** connect wallet, start KYC, sign the challenge with MetaMask,
  then continue with Cartão de Cidadão (real eIDAS) or simulated KYC (dev only);
  view status / role / expiry; reverify when the attestation expires.
- **Trading:** submit orders (OrderBook), add/remove liquidity and swap (AMM).
- **Admin view:** revoke users, trigger reconciliation, browse the audit log,
  look up user state.

## Debugging

Set `VITE_DEBUG=true` in `.env` and open the browser console (F12) to see API
calls, keys used, and response statuses.

## Build

```bash
npm run build      # production build to dist/
npm run preview    # preview the production build
```
