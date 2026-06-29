import { useState, useEffect } from 'react';
import { Contract, formatUnits } from 'ethers';
import { useWallet } from '../context/WalletContext';
import './Portfolio.css';

// ERC-20 ABI (minimal for balanceOf, name, symbol)
const ERC20_ABI = [
  'function balanceOf(address account) public view returns (uint256)',
  'function name() public view returns (string)',
  'function symbol() public view returns (string)',
  'function decimals() public view returns (uint8)'
];

// OrderSubmitted event — MUST match the on-chain signature in
// contracts/interfaces/IMatchingEngine.sol (emitted by both OrderBook and AMM).
const ORDERBOOK_EVENT_ABI = [
  'event OrderSubmitted(uint256 indexed orderId, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
];

export function Portfolio() {
  const { address, provider, isConnected } = useWallet();
  const [cashBalance, setCashBalance] = useState('0');
  const [securitiesBalance, setSecuritiesBalance] = useState('0');
  const [cashToken, setCashToken] = useState({ name: '', symbol: '' });
  const [securitiesToken, setSecuritiesToken] = useState({ name: '', symbol: '' });
  const [tradeHistory, setTradeHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isConnected || !provider || !address) {
      setCashBalance('0');
      setSecuritiesBalance('0');
      setTradeHistory([]);
      return;
    }

    const fetchPortfolioData = async () => {
      try {
        setLoading(true);
        setError(null);

        const cashTokenAddress = import.meta.env.VITE_CASH_TOKEN_ADDRESS;
        const securitiesTokenAddress = import.meta.env.VITE_SECURITIES_TOKEN_ADDRESS;
        const ammAddress = import.meta.env.VITE_AMM_ADDRESS;
        const orderBookAddress = import.meta.env.VITE_ORDERBOOK_ADDRESS;

        if (!cashTokenAddress || !securitiesTokenAddress || !ammAddress || !orderBookAddress) {
          setError('Contract addresses not configured. Please deploy smart contracts and configure environment variables.');
          return;
        }

        // Create contract instances
        const cashContract = new Contract(cashTokenAddress, ERC20_ABI, provider);
        const securitiesContract = new Contract(securitiesTokenAddress, ERC20_ABI, provider);

        // Fetch balances and token info
        const [cashBal, securitiesBal, cashName, cashSymbol, securitiesName, securitiesSymbol] = await Promise.all([
          cashContract.balanceOf(address),
          securitiesContract.balanceOf(address),
          cashContract.name(),
          cashContract.symbol(),
          securitiesContract.name(),
          securitiesContract.symbol()
        ]);

        // Format balances
        const formattedCashBalance = formatUnits(cashBal, 18);
        const formattedSecuritiesBalance = formatUnits(securitiesBal, 18);

        setCashBalance(formattedCashBalance);
        setSecuritiesBalance(formattedSecuritiesBalance);
        setCashToken({ name: cashName, symbol: cashSymbol });
        setSecuritiesToken({ name: securitiesName, symbol: securitiesSymbol });

        // Fetch trade history from both AMM and OrderBook
        await fetchTradeHistory(provider, ammAddress, orderBookAddress, address);
      } catch (err) {
        console.error('Error fetching portfolio data:', err);
        setError(err.message || 'Failed to fetch portfolio data');
      } finally {
        setLoading(false);
      }
    };

    fetchPortfolioData();
  }, [isConnected, provider, address]);

  const fetchTradeHistory = async (provider, ammAddress, orderBookAddress, userAddress) => {
    try {
      const cashTokenAddress = import.meta.env.VITE_CASH_TOKEN_ADDRESS;
      const fromBlock = Math.max(0, (await provider.getBlockNumber()) - 1024);

      // Collect this user's OrderSubmitted events from one matching engine.
      const collect = async (engineAddress) => {
        const contract = new Contract(engineAddress, ORDERBOOK_EVENT_ABI, provider);
        // Filter: OrderSubmitted(orderId indexed, trader indexed) — match trader.
        const events = await contract.queryFilter(
          contract.filters.OrderSubmitted(null, userAddress),
          fromBlock
        );

        return Promise.all(
          events.map(async (ev) => {
            const [orderId, , tokenIn, , amountIn, amountOut] = ev.args;
            const isBuy = tokenIn.toLowerCase() === cashTokenAddress.toLowerCase();
            // amount = securities leg; price = cash per security
            const amount = formatUnits(isBuy ? amountOut : amountIn, 18);
            const price = isBuy
              ? Number(amountIn) / Number(amountOut)
              : Number(amountOut) / Number(amountIn);
            const block = await ev.getBlock();
            return {
              orderId: orderId.toString(),
              direction: isBuy ? 0 : 1,
              amount,
              price: price.toString(),
              timestamp: block ? block.timestamp : 0,
            };
          })
        );
      };

      const [ammTrades, obTrades] = await Promise.all([
        collect(ammAddress).catch(() => []),
        collect(orderBookAddress).catch(() => []),
      ]);

      const trades = [...ammTrades, ...obTrades].sort((a, b) => b.timestamp - a.timestamp);
      setTradeHistory(trades);
    } catch (err) {
      console.error('Error fetching trade history:', err);
      setTradeHistory([]);
    }
  };

  const calculateAllocation = () => {
    const cashVal = parseFloat(cashBalance) || 0;
    const securitiesVal = parseFloat(securitiesBalance) || 0;
    const total = cashVal + securitiesVal;

    if (total === 0) {
      return { cashPercent: 0, securitiesPercent: 0 };
    }

    return {
      cashPercent: ((cashVal / total) * 100).toFixed(1),
      securitiesPercent: ((securitiesVal / total) * 100).toFixed(1)
    };
  };

  const allocation = calculateAllocation();

  if (!isConnected) {
    return (
      <div className="portfolio-page">
        <div className="portfolio-container">
          <h1>Portfolio</h1>
          <div className="empty-state">
            <p>Please connect your wallet to view your portfolio.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="portfolio-page">
      <div className="portfolio-container">
        <h1>Portfolio</h1>

        {error && (
          <div className="error-message">
            <p>{error}</p>
          </div>
        )}

        {loading ? (
          <div className="loading">
            <p>Loading portfolio data...</p>
          </div>
        ) : (
          <>
            {/* Holdings Section */}
            <div className="holdings-section">
              <h2>Holdings</h2>

              <div className="holdings-grid">
                {/* Holdings Cards */}
                <div className="holdings-card">
                  <div className="card-header">
                    <h3>{cashToken.symbol || 'CASH'}</h3>
                    <span className="percentage">{allocation.cashPercent}%</span>
                  </div>
                  <div className="card-body">
                    <div className="balance">
                      {parseFloat(cashBalance).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 6
                      })}
                    </div>
                    <div className="token-name">{cashToken.name || 'Cash Token'}</div>
                  </div>
                </div>

                <div className="holdings-card">
                  <div className="card-header">
                    <h3>{securitiesToken.symbol || 'SEC'}</h3>
                    <span className="percentage">{allocation.securitiesPercent}%</span>
                  </div>
                  <div className="card-body">
                    <div className="balance">
                      {parseFloat(securitiesBalance).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 6
                      })}
                    </div>
                    <div className="token-name">{securitiesToken.name || 'Securities Token'}</div>
                  </div>
                </div>
              </div>

              {/* Allocation Bar */}
              <div className="allocation-bar">
                <div className="bar-container">
                  <div
                    className="bar-segment cash-segment"
                    style={{ width: `${allocation.cashPercent}%` }}
                    title={`${cashToken.symbol || 'CASH'}: ${allocation.cashPercent}%`}
                  />
                  <div
                    className="bar-segment securities-segment"
                    style={{ width: `${allocation.securitiesPercent}%` }}
                    title={`${securitiesToken.symbol || 'SEC'}: ${allocation.securitiesPercent}%`}
                  />
                </div>
                <div className="bar-legend">
                  <div className="legend-item">
                    <span className="legend-color cash-color" />
                    <span>{cashToken.symbol || 'CASH'} - {allocation.cashPercent}%</span>
                  </div>
                  <div className="legend-item">
                    <span className="legend-color securities-color" />
                    <span>{securitiesToken.symbol || 'SEC'} - {allocation.securitiesPercent}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Trade History Section */}
            <div className="trade-history-section">
              <h2>Trade History</h2>

              {tradeHistory.length === 0 ? (
                <div className="no-trades">
                  <p>No trades found for your account.</p>
                </div>
              ) : (
                <div className="trades-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Direction</th>
                        <th>Amount</th>
                        <th>Price</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tradeHistory.map((trade, idx) => (
                        <tr key={idx}>
                          <td>{new Date(trade.timestamp * 1000).toLocaleString()}</td>
                          <td>
                            <span className={`direction ${trade.direction === 0 ? 'buy' : 'sell'}`}>
                              {trade.direction === 0 ? 'BUY' : 'SELL'}
                            </span>
                          </td>
                          <td>{parseFloat(trade.amount).toLocaleString('en-US', { maximumFractionDigits: 6 })}</td>
                          <td>{parseFloat(trade.price).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
                          <td>
                            <span className="status completed">Completed</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="wallet-info">
              <p>
                <strong>Connected Address:</strong> {address.substring(0, 6)}...{address.substring(address.length - 4)}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
