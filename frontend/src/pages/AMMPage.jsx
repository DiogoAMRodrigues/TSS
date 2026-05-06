import { useState, useEffect } from 'react';
import { Contract, formatUnits, parseUnits, ZeroAddress } from 'ethers';
import { Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { api } from '../services/api';
import './AMMPage.css';

// Minimal ABI for AMM contract
const AMM_ABI = [
  'function getAmountOut(address tokenIn, uint256 amountIn) view returns (uint256)',
  'function submitOrder(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (bool)',
  'function reserveCash() view returns (uint256)',
  'function reserveSecurities() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function addLiquidity(uint256 cashAmount, uint256 securitiesAmount) returns (uint256)',
  'function removeLiquidity(uint256 sharesBurned) returns (uint256, uint256)',
  'function liquidityShares(address account) view returns (uint256)',
  'function totalLiquidityShares() view returns (uint256)',
];

// Minimal ABI for ERC20 tokens
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export default function AMMPage() {
  const { address, isConnected, signer, provider } = useWallet();

  // Swap state
  const [swapDirection, setSwapDirection] = useState('cash-to-securities'); // 'cash-to-securities' or 'securities-to-cash'
  const [amountIn, setAmountIn] = useState('');
  const [amountOut, setAmountOut] = useState('');
  const [slippageTolerance, setSlippageTolerance] = useState('0.5');
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  const [swapLoading, setSwapLoading] = useState(false);

  // Pool state
  const [reserveCash, setReserveCash] = useState('0');
  const [reserveSecurities, setReserveSecurities] = useState('0');
  const [feeBps, setFeeBps] = useState('0');
  const [currentPrice, setCurrentPrice] = useState('0');

  // Liquidity state
  const [userLpShares, setUserLpShares] = useState('0');
  const [totalLpShares, setTotalLpShares] = useState('0');
  const [addLiquidityCash, setAddLiquidityCash] = useState('');
  const [addLiquiditySecurities, setAddLiquiditySecurities] = useState('');
  const [removeLiquidityShares, setRemoveLiquidityShares] = useState('');
  const [lpLoading, setLpLoading] = useState(false);

  // General state
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [kycApproved, setKycApproved] = useState(false);

  const ammAddress = import.meta.env.VITE_AMM_ADDRESS;
  const cashTokenAddress = import.meta.env.VITE_CASH_TOKEN_ADDRESS;
  const securitiesTokenAddress = import.meta.env.VITE_SECURITIES_TOKEN_ADDRESS;

  // Check KYC status when address changes
  useEffect(() => {
    const checkKyc = async () => {
      if (!address) return;
      try {
        const res = await api.getUser(address);
        setKycApproved(res.local?.kycStatus === 'approved');
      } catch {
        setKycApproved(false);
      }
    };
    checkKyc();
  }, [address]);

  // Get contract instances
  const getAmmContract = () => {
    if (!signer) return null;
    return new Contract(ammAddress, AMM_ABI, signer);
  };

  const getTokenContract = (tokenAddress) => {
    if (!signer) return null;
    return new Contract(tokenAddress, ERC20_ABI, signer);
  };

  // Fetch pool info
  const fetchPoolInfo = async () => {
    if (!provider) return;
    try {
      const ammContract = new Contract(ammAddress, AMM_ABI, provider);
      const [cash, securities, fee] = await Promise.all([
        ammContract.reserveCash(),
        ammContract.reserveSecurities(),
        ammContract.feeBps(),
      ]);

      setReserveCash(formatUnits(cash, 18));
      setReserveSecurities(formatUnits(securities, 18));
      setFeeBps(Number(fee));

      // Calculate current price (securities per cash)
      if (cash > 0n) {
        const price = Number(securities) / Number(cash);
        setCurrentPrice(price.toFixed(6));
      }
    } catch (err) {
      console.error('Error fetching pool info:', err);
    }
  };

  // Fetch user LP shares
  const fetchUserLpShares = async () => {
    if (!provider || !address) return;
    try {
      const ammContract = new Contract(ammAddress, AMM_ABI, provider);
      const [userShares, totalShares] = await Promise.all([
        ammContract.liquidityShares(address),
        ammContract.totalLiquidityShares(),
      ]);

      setUserLpShares(formatUnits(userShares, 18));
      setTotalLpShares(formatUnits(totalShares, 18));
    } catch (err) {
      console.error('Error fetching LP shares:', err);
    }
  };

  // Get quote for swap
  const getQuote = async (amount, direction) => {
    if (!provider || !amount || amount === '0') {
      setAmountOut('');
      return;
    }

    try {
      setIsLoadingQuote(true);
      const ammContract = new Contract(ammAddress, AMM_ABI, provider);
      const tokenIn = direction === 'cash-to-securities' ? cashTokenAddress : securitiesTokenAddress;
      const amountInWei = parseUnits(amount, 18);

      const quote = await ammContract.getAmountOut(tokenIn, amountInWei);
      setAmountOut(formatUnits(quote, 18));
    } catch (err) {
      console.error('Error getting quote:', err);
      setAmountOut('');
    } finally {
      setIsLoadingQuote(false);
    }
  };

  // Handle amount input change
  useEffect(() => {
    const timer = setTimeout(() => {
      if (amountIn) {
        getQuote(amountIn, swapDirection);
      } else {
        setAmountOut('');
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [amountIn, swapDirection]);

  // Fetch pool info on mount and periodically
  useEffect(() => {
    fetchPoolInfo();
    const interval = setInterval(fetchPoolInfo, 5000);
    return () => clearInterval(interval);
  }, [provider]);

  // Fetch user LP shares when address changes
  useEffect(() => {
    if (address) {
      fetchUserLpShares();
      const interval = setInterval(fetchUserLpShares, 5000);
      return () => clearInterval(interval);
    }
  }, [address, provider]);

  // Execute swap
  const handleSwap = async () => {
    if (!signer || !amountIn || !amountOut) {
      setError('Please enter an amount');
      return;
    }

    if (!kycApproved) {
      setError('KYC verification required before trading. Please complete KYC first.');
      return;
    }

    try {
      setSwapLoading(true);
      setError('');
      setSuccess('');

      const tokenIn = swapDirection === 'cash-to-securities' ? cashTokenAddress : securitiesTokenAddress;
      const tokenOut = swapDirection === 'cash-to-securities' ? securitiesTokenAddress : cashTokenAddress;
      const amountInWei = parseUnits(amountIn, 18);
      const amountOutWei = parseUnits(amountOut, 18);

      // Calculate minimum amount out with slippage
      const slippageBps = Math.floor(parseFloat(slippageTolerance) * 100);
      const amountOutMin = (amountOutWei * BigInt(10000 - slippageBps)) / BigInt(10000);

      // Approve token if needed
      const tokenContract = getTokenContract(tokenIn);
      const allowance = await tokenContract.allowance(address, ammAddress);

      if (allowance < amountInWei) {
        const approveTx = await tokenContract.approve(ammAddress, amountInWei);
        await approveTx.wait();
      }

      // Execute swap
      const ammContract = getAmmContract();
      const tx = await ammContract.submitOrder(tokenIn, tokenOut, amountInWei, amountOutMin);
      await tx.wait();

      setSuccess(`Swap successful! Received ${formatUnits(amountOutWei, 18)} tokens`);
      setAmountIn('');
      setAmountOut('');

      // Refresh pool info
      await fetchPoolInfo();
      await fetchUserLpShares();
    } catch (err) {
      setError(err.message || 'Swap failed');
      console.error('Swap error:', err);
    } finally {
      setSwapLoading(false);
    }
  };

  // Add liquidity
  const handleAddLiquidity = async () => {
    if (!signer || !addLiquidityCash || !addLiquiditySecurities) {
      setError('Please enter both amounts');
      return;
    }

    if (!kycApproved) {
      setError('KYC verification required before trading. Please complete KYC first.');
      return;
    }

    try {
      setLpLoading(true);
      setError('');
      setSuccess('');

      const cashAmount = parseUnits(addLiquidityCash, 18);
      const securitiesAmount = parseUnits(addLiquiditySecurities, 18);

      // Approve both tokens
      const cashContract = getTokenContract(cashTokenAddress);
      const securitiesContract = getTokenContract(securitiesTokenAddress);

      const [cashAllowance, securitiesAllowance] = await Promise.all([
        cashContract.allowance(address, ammAddress),
        securitiesContract.allowance(address, ammAddress),
      ]);

      if (cashAllowance < cashAmount) {
        const tx = await cashContract.approve(ammAddress, cashAmount);
        await tx.wait();
      }

      if (securitiesAllowance < securitiesAmount) {
        const tx = await securitiesContract.approve(ammAddress, securitiesAmount);
        await tx.wait();
      }

      // Add liquidity
      const ammContract = getAmmContract();
      const tx = await ammContract.addLiquidity(cashAmount, securitiesAmount);
      await tx.wait();

      setSuccess('Liquidity added successfully!');
      setAddLiquidityCash('');
      setAddLiquiditySecurities('');

      // Refresh
      await fetchPoolInfo();
      await fetchUserLpShares();
    } catch (err) {
      setError(err.message || 'Add liquidity failed');
      console.error('Add liquidity error:', err);
    } finally {
      setLpLoading(false);
    }
  };

  // Remove liquidity
  const handleRemoveLiquidity = async () => {
    if (!signer || !removeLiquidityShares) {
      setError('Please enter amount of shares to burn');
      return;
    }

    try {
      setLpLoading(true);
      setError('');
      setSuccess('');

      const shares = parseUnits(removeLiquidityShares, 18);
      const ammContract = getAmmContract();
      const tx = await ammContract.removeLiquidity(shares);
      await tx.wait();

      setSuccess('Liquidity removed successfully!');
      setRemoveLiquidityShares('');

      // Refresh
      await fetchPoolInfo();
      await fetchUserLpShares();
    } catch (err) {
      setError(err.message || 'Remove liquidity failed');
      console.error('Remove liquidity error:', err);
    } finally {
      setLpLoading(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="amm-page">
        <div className="container">
          <div className="card">
            <h2>AMM - Automated Market Maker</h2>
            <p>Please connect your wallet to use the AMM.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="amm-page">
      <div className="container">
        <h1>Automated Market Maker</h1>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {!kycApproved && isConnected && (
          <div className="kyc-warning">
            ⚠️ KYC verification required before trading. <Link to="/kyc">Complete KYC</Link>
          </div>
        )}

        <div className="amm-grid">
          {/* Swap Card */}
          <div className="card swap-card">
            <h2>Swap</h2>

            <div className="form-group">
              <label>Direction</label>
              <select
                value={swapDirection}
                onChange={(e) => {
                  setSwapDirection(e.target.value);
                  setAmountIn('');
                  setAmountOut('');
                }}
                className="select-input"
              >
                <option value="cash-to-securities">Cash → Securities</option>
                <option value="securities-to-cash">Securities → Cash</option>
              </select>
            </div>

            <div className="form-group">
              <label>Amount In</label>
              <input
                type="number"
                value={amountIn}
                onChange={(e) => setAmountIn(e.target.value)}
                placeholder="0.0"
                className="input-field"
                disabled={swapLoading}
              />
            </div>

            <div className="form-group">
              <label>Estimated Amount Out</label>
              <div className="amount-out-display">
                {isLoadingQuote ? (
                  <span className="loading">Loading quote...</span>
                ) : (
                  <span>{amountOut || '0.0'}</span>
                )}
              </div>
            </div>

            <div className="form-group">
              <label>Slippage Tolerance (%)</label>
              <input
                type="number"
                value={slippageTolerance}
                onChange={(e) => setSlippageTolerance(e.target.value)}
                placeholder="0.5"
                className="input-field"
                step="0.1"
                min="0"
                disabled={swapLoading}
              />
            </div>

            <button
              onClick={handleSwap}
              disabled={!amountIn || !amountOut || swapLoading || isLoadingQuote}
              className="btn btn-primary"
            >
              {swapLoading ? 'Swapping...' : 'Swap'}
            </button>
          </div>

          {/* Pool Info Card */}
          <div className="card pool-info-card">
            <h2>Pool Info</h2>

            <div className="info-row">
              <span className="label">Cash Reserve</span>
              <span className="value">{parseFloat(reserveCash).toFixed(2)}</span>
            </div>

            <div className="info-row">
              <span className="label">Securities Reserve</span>
              <span className="value">{parseFloat(reserveSecurities).toFixed(2)}</span>
            </div>

            <div className="info-row">
              <span className="label">Fee</span>
              <span className="value">{feeBps / 100}%</span>
            </div>

            <div className="info-row">
              <span className="label">Current Price</span>
              <span className="value">{currentPrice} SEC/CASH</span>
            </div>

            <div className="info-row">
              <span className="label">Total LP Shares</span>
              <span className="value">{parseFloat(totalLpShares).toFixed(2)}</span>
            </div>
          </div>

          {/* Liquidity Card */}
          <div className="card liquidity-card">
            <h2>Liquidity</h2>

            <div className="info-row">
              <span className="label">Your LP Shares</span>
              <span className="value">{parseFloat(userLpShares).toFixed(2)}</span>
            </div>

            <div className="divider"></div>

            <h3>Add Liquidity</h3>

            <div className="form-group">
              <label>Cash Amount</label>
              <input
                type="number"
                value={addLiquidityCash}
                onChange={(e) => setAddLiquidityCash(e.target.value)}
                placeholder="0.0"
                className="input-field"
                disabled={lpLoading}
              />
            </div>

            <div className="form-group">
              <label>Securities Amount</label>
              <input
                type="number"
                value={addLiquiditySecurities}
                onChange={(e) => setAddLiquiditySecurities(e.target.value)}
                placeholder="0.0"
                className="input-field"
                disabled={lpLoading}
              />
            </div>

            <button
              onClick={handleAddLiquidity}
              disabled={!addLiquidityCash || !addLiquiditySecurities || lpLoading}
              className="btn btn-primary"
            >
              {lpLoading ? 'Adding...' : 'Add Liquidity'}
            </button>

            <div className="divider"></div>

            <h3>Remove Liquidity</h3>

            <div className="form-group">
              <label>LP Shares to Burn</label>
              <input
                type="number"
                value={removeLiquidityShares}
                onChange={(e) => setRemoveLiquidityShares(e.target.value)}
                placeholder="0.0"
                className="input-field"
                disabled={lpLoading}
              />
            </div>

            <button
              onClick={handleRemoveLiquidity}
              disabled={!removeLiquidityShares || lpLoading}
              className="btn btn-secondary"
            >
              {lpLoading ? 'Removing...' : 'Remove Liquidity'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
