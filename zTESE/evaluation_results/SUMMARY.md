# TSS Evaluation Results

_Generated 2026-06-02T19:28:34.761Z_

## §5.1 Functional Validation

Total: 11  |  Passed: 11

| ID | Description | Result |
|---|---|---|
| E2E-1 | Onboarding + asset issuance + registry registration | PASS |
| E2E-2 | OrderBook buy+sell -> match -> atomic DvP | PASS |
| E2E-3 | AMM initialize+liquidity+swap -> atomic DvP | PASS |
| E2E-4 | Hot-swap engines at runtime - same Settlement contract serves OB then AMM | PASS |
| NEG-1 | Non-whitelisted user rejected at submission | PASS |
| NEG-2 | Revoked attestation prevents matching of resting order | PASS |
| NEG-3 | Deactivated token rejected at submission | PASS |
| NEG-4 | Self-trade skipped by matching loop (no settlement) | PASS |
| NEG-5 | Paused Settlement reverts matching tx | PASS |
| NEG-6 | AMM slippage protection (amountOutMin) honoured | PASS |
| NEG-7 | Expired attestation prevents matching of resting order | PASS |

## §5.2 Gas Cost per Operation (Table I)

| Operation | Gas |
|---|---:|
| deployIdentity | 1,733,396 |
| deployRegistry | 1,365,127 |
| deploySettlement | 1,997,715 |
| deploySecuritiesToken | 2,022,556 |
| deployCashToken | 1,947,711 |
| whitelistTrader | 120,471 |
| registerAssetCash | 176,267 |
| registerAssetSecurities | 159,179 |
| deployOrderBook | 2,990,266 |
| authorizeEngineOB | 63,066 |
| deployAmm | 4,859,969 |
| authorizeEngineAMM | 63,066 |
| initializeAmmPool | 180,848 |
| mintCashToken | 96,408 |
| approveCashToken | 46,800 |
| submitOrderOB_resting | 283,569 |
| submitOrderOB_match_and_settle | 883,702 |
| cancelOrderOB | 54,153 |
| addLiquidityAMM_initial | 290,820 |
| addLiquidityAMM_subsequent | 146,698 |
| submitOrderAMM_swap | 766,103 |
| removeLiquidityAMM | 129,049 |

## §5.2 OrderBook Depth Scaling (Figure 3)

| Open orders depth | OrderBook submitOrder gas | AMM swap gas |
|---:|---:|---:|
| 0 | 283,569 | 800,303 |
| 1 | 297,151 | 800,303 |
| 5 | 408,701 | 800,303 |
| 10 | 548,154 | 800,315 |
| 20 | 827,038 | 800,315 |
| 40 | 1,384,810 | 800,315 |

## §5.2 AMM Slippage Curve

Pool reserves: 1000000 cash / 1000000 sec, fee 30 bps.

| Trade size (% of pool) | Realised price (cash/sec) | Slippage (%) |
|---:|---:|---:|
| 0.1 | 1.004009 | 0.4 |
| 1 | 1.013009 | 1.3 |
| 5 | 1.053009 | 5.3 |
| 10 | 1.103009 | 10.3 |
| 25 | 1.253009 | 25.3 |

## §5.2 Wall-clock Latency per Operation

Network: `besu`, samples per op: 100.  
_Besu IBFT 2.0 (2s block period). Numbers reflect real settle latency._

| Operation | Mean (ms) | p50 (ms) | p95 (ms) | Min | Max |
|---|---:|---:|---:|---:|---:|
| submitOrderOB_resting | 1997.97 | 2084 | 2097 | 1565 | 2104 |
| submitOrderOB_match_settle | 1872.39 | 2071 | 2088 | 1556 | 2097 |
| submitOrderAMM_swap | 1998.29 | 2067 | 2083 | 1552 | 2088 |

