import { useState, useEffect } from 'react';
import { Contract, formatUnits, ZeroAddress } from 'ethers';
import { useWallet } from '../context/WalletContext';
import './Dashboard.css';

// ERC-20 ABI (minimal for balanceOf, name, symbol)
const ERC20_ABI = [
  'function balanceOf(address account) public view returns (uint256)',
  'function name() public view returns (string)',
  'function symbol() public view returns (string)',
  'function decimals() public view returns (uint8)'
];

export function Dashboard() {
  const { address, provider, isConnected } = useWallet();
  const [cashBalance, setCashBalance] = useState('0');
  const [securitiesBalance, setSecuritiesBalance] = useState('0');
  const [cashToken, setCashToken] = useState({ name: '', symbol: '' });
  const [securitiesToken, setSecuritiesToken] = useState({ name: '', symbol: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isConnected || !provider || !address) {
      setCashBalance('0');
      setSecuritiesBalance('0');
      return;
    }

    const fetchBalances = async () => {
      try {
        setLoading(true);
        setError(null);

        const cashTokenAddress = import.meta.env.VITE_CASH_TOKEN_ADDRESS;
        const securitiesTokenAddress = import.meta.env.VITE_SECURITIES_TOKEN_ADDRESS;

        console.log('[Dashboard] Token addresses:', { cashTokenAddress, securitiesTokenAddress });
        console.log('[Dashboard] Provider network:', await provider.getNetwork());

        if (!cashTokenAddress || !securitiesTokenAddress) {
          setError('Token addresses not configured. Please deploy smart contracts and configure environment variables.');
          return;
        }

        // Create contract instances
        const cashContract = new Contract(cashTokenAddress, ERC20_ABI, provider);
        const securitiesContract = new Contract(securitiesTokenAddress, ERC20_ABI, provider);

        // Fetch balances and token info in parallel
        const [cashBal, securitiesBal, cashName, cashSymbol, securitiesName, securitiesSymbol] = await Promise.all([
          cashContract.balanceOf(address),
          securitiesContract.balanceOf(address),
          cashContract.name(),
          cashContract.symbol(),
          securitiesContract.name(),
          securitiesContract.symbol()
        ]);

        // Format balances (assuming 18 decimals)
        const formattedCashBalance = formatUnits(cashBal, 18);
        const formattedSecuritiesBalance = formatUnits(securitiesBal, 18);

        setCashBalance(formattedCashBalance);
        setSecuritiesBalance(formattedSecuritiesBalance);
        setCashToken({ name: cashName, symbol: cashSymbol });
        setSecuritiesToken({ name: securitiesName, symbol: securitiesSymbol });
      } catch (err) {
        console.error('Error fetching balances:', err);
        setError(err.message || 'Failed to fetch balances');
      } finally {
        setLoading(false);
      }
    };

    fetchBalances();
  }, [isConnected, provider, address]);

  const calculateTotalValue = () => {
    // Simple estimate: total value = cash balance + securities balance
    // In a real app, you'd fetch AMM reserves to calculate securities value
    const cashValue = parseFloat(cashBalance) || 0;
    const securitiesValue = parseFloat(securitiesBalance) || 0;
    return (cashValue + securitiesValue).toFixed(2);
  };

  if (!isConnected) {
    return (
      <div className="dashboard-page">
        <div className="dashboard-container">
          <h1>Token Dashboard</h1>
          <div className="empty-state">
            <p>Please connect your wallet to view your token balances.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-container">
        <h1>Token Dashboard</h1>

        {error && (
          <div className="error-message">
            <p>{error}</p>
          </div>
        )}

        {loading ? (
          <div className="loading">
            <p>Loading balances...</p>
          </div>
        ) : (
          <>
            <div className="cards-grid">
              {/* Cash Token Card */}
              <div className="balance-card">
                <div className="card-header">
                  <h2>{cashToken.name || 'Cash Token'}</h2>
                  <span className="token-symbol">{cashToken.symbol || 'CASH'}</span>
                </div>
                <div className="card-body">
                  <div className="balance-amount">
                    {parseFloat(cashBalance).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 6
                    })}
                  </div>
                  <div className="balance-label">{cashToken.symbol || 'CASH'} Balance</div>
                </div>
              </div>

              {/* Securities Token Card */}
              <div className="balance-card">
                <div className="card-header">
                  <h2>{securitiesToken.name || 'Securities Token'}</h2>
                  <span className="token-symbol">{securitiesToken.symbol || 'SEC'}</span>
                </div>
                <div className="card-body">
                  <div className="balance-amount">
                    {parseFloat(securitiesBalance).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 6
                    })}
                  </div>
                  <div className="balance-label">{securitiesToken.symbol || 'SEC'} Balance</div>
                </div>
              </div>

              {/* Total Portfolio Value Card */}
              <div className="balance-card total-value-card">
                <div className="card-header">
                  <h2>Total Portfolio Value</h2>
                </div>
                <div className="card-body">
                  <div className="balance-amount">
                    {calculateTotalValue()}
                  </div>
                  <div className="balance-label">Estimated Total Value</div>
                </div>
              </div>
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
