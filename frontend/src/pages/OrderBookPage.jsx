/* eslint-disable react-hooks/exhaustive-deps */
import { useState, useEffect, useCallback } from 'react';
import { Contract, formatUnits, parseUnits } from 'ethers';
import { Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { api } from '../services/api';
import './OrderBookPage.css';

// Minimal ABI for OrderBook contract
const ORDERBOOK_ABI = [
  'function submitOrder(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) returns (uint256)',
  'function cancelOrder(uint256 orderId)',
  'function getOrder(uint256 orderId) returns (tuple(uint256 orderId, address trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 timestamp, uint8 status))',
  // NOTE: these MUST match the on-chain event signatures exactly (see
  // contracts/interfaces/IMatchingEngine.sol) or parseLog/queryFilter return
  // nothing and the book fails to load.
  'event OrderSubmitted(uint256 indexed orderId, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  'event OrderCancelled(uint256 indexed orderId, address indexed trader)',
  'event OrderMatched(uint256 indexed matchId, uint256 indexed buyOrderId, uint256 indexed sellOrderId)',
];

// Minimal ABI for ERC20 tokens
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) returns (uint256)',
  'function balanceOf(address account) returns (uint256)',
  'function decimals() returns (uint8)',
];

const ORDER_STATUS = {
  OPEN: 0,
  MATCHED: 1,
  CANCELLED: 2,
};

export function OrderBookPage() {
  const { address, isConnected, signer, provider } = useWallet();
  const [orderType, setOrderType] = useState('buy'); // 'buy' or 'sell'
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [kycApproved, setKycApproved] = useState(false);

  // Order book state
  const [orders, setOrders] = useState(new Map()); // orderId -> order
  const [myOrders, setMyOrders] = useState([]);
  const [bookLoading, setBookLoading] = useState(false);

  const orderbookAddress = import.meta.env.VITE_ORDERBOOK_ADDRESS;
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

  // Truncate address for display
  const truncateAddress = (addr) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  // Load historical orders from events
  const loadOrderHistory = useCallback(async () => {
    if (!provider || !orderbookAddress) return;

    try {
      setBookLoading(true);
      const contract = new Contract(orderbookAddress, ORDERBOOK_ABI, provider);
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 1024);

      // queryFilter returns already-parsed EventLog objects (with .args) and
      // filters by the correct event topic — no manual topics/parseLog needed.
      const [submitEvents, cancelEvents, matchEvents] = await Promise.all([
        contract.queryFilter(contract.filters.OrderSubmitted(), fromBlock),
        contract.queryFilter(contract.filters.OrderCancelled(), fromBlock),
        contract.queryFilter(contract.filters.OrderMatched(), fromBlock),
      ]);

      // Parse events
      const parsedSubmit = submitEvents.map((ev) => ({
        orderId: ev.args[0],
        trader: ev.args[1],
        tokenIn: ev.args[2],
        tokenOut: ev.args[3],
        amountIn: ev.args[4],
        amountOut: ev.args[5],
        status: ORDER_STATUS.OPEN,
      }));

      // OrderCancelled(orderId, trader)
      const cancelledIds = new Set(
        cancelEvents.map((ev) => ev.args[0].toString())
      );

      // OrderMatched(matchId, buyOrderId, sellOrderId) — both legs are matched
      const matchedIds = new Set();
      matchEvents.forEach((ev) => {
        matchedIds.add(ev.args[1].toString()); // buyOrderId
        matchedIds.add(ev.args[2].toString()); // sellOrderId
      });

      // Build order map with status updates
      const orderMap = new Map();
      parsedSubmit.forEach((order) => {
        const orderId = order.orderId.toString();
        let status = ORDER_STATUS.OPEN;
        if (cancelledIds.has(orderId)) status = ORDER_STATUS.CANCELLED;
        if (matchedIds.has(orderId)) status = ORDER_STATUS.MATCHED;

        orderMap.set(orderId, { ...order, status });
      });

      setOrders(orderMap);

      // Filter user's orders
      if (address) {
        const userOrders = Array.from(orderMap.values())
          .filter((order) => order.trader.toLowerCase() === address.toLowerCase())
          .sort((a, b) => Number(b.orderId) - Number(a.orderId));
        setMyOrders(userOrders);
      }
    } catch (err) {
      console.error('Error loading order history:', err);
      setError('Failed to load order book');
    } finally {
      setBookLoading(false);
    }
  }, [provider, orderbookAddress, address]);

  // Load order history on mount and when provider changes
  useEffect(() => {
    loadOrderHistory();
  }, [loadOrderHistory]);

  // Listen for new events
  useEffect(() => {
    if (!provider || !orderbookAddress) return;

    const contract = new Contract(orderbookAddress, ORDERBOOK_ABI, provider);

    const handleOrderSubmitted = (orderId, trader, tokenIn, tokenOut, amountIn, amountOut) => {
      const order = {
        orderId,
        trader,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        status: ORDER_STATUS.OPEN,
      };

      setOrders((prev) => new Map(prev).set(orderId.toString(), order));

      if (trader.toLowerCase() === address?.toLowerCase()) {
        setMyOrders((prev) => [order, ...prev]);
      }
    };

    const handleOrderCancelled = (orderId) => {
      setOrders((prev) => {
        const updated = new Map(prev);
        const order = updated.get(orderId.toString());
        if (order) {
          updated.set(orderId.toString(), { ...order, status: ORDER_STATUS.CANCELLED });
        }
        return updated;
      });

      setMyOrders((prev) =>
        prev.map((order) =>
          order.orderId.toString() === orderId.toString()
            ? { ...order, status: ORDER_STATUS.CANCELLED }
            : order
        )
      );
    };

    const handleOrderMatched = (matchId, buyOrderId, sellOrderId) => {
      const legIds = [buyOrderId.toString(), sellOrderId.toString()];

      setOrders((prev) => {
        const updated = new Map(prev);
        legIds.forEach((id) => {
          const order = updated.get(id);
          if (order) {
            updated.set(id, { ...order, status: ORDER_STATUS.MATCHED });
          }
        });
        return updated;
      });

      setMyOrders((prev) =>
        prev.map((order) =>
          legIds.includes(order.orderId.toString())
            ? { ...order, status: ORDER_STATUS.MATCHED }
            : order
        )
      );
    };

    contract.on('OrderSubmitted', handleOrderSubmitted);
    contract.on('OrderCancelled', handleOrderCancelled);
    contract.on('OrderMatched', handleOrderMatched);

    return () => {
      contract.removeAllListeners('OrderSubmitted');
      contract.removeAllListeners('OrderCancelled');
      contract.removeAllListeners('OrderMatched');
    };
  }, [provider, orderbookAddress, address]);

  // Handle order submission
  const handleSubmitOrder = async (e) => {
    e.preventDefault();
    if (!isConnected || !signer) {
      setError('Please connect your wallet');
      return;
    }

    if (!kycApproved) {
      setError('KYC verification required before trading. Please complete KYC first.');
      return;
    }

    if (!amount || !price || parseFloat(amount) <= 0 || parseFloat(price) <= 0) {
      setError('Please enter valid amount and price');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const contract = new Contract(orderbookAddress, ORDERBOOK_ABI, signer);

      // Parse amounts with 18 decimals
      const amountIn = parseUnits(amount, 18);
      const amountOut = parseUnits((parseFloat(amount) * parseFloat(price)).toString(), 18);

      // Determine token order based on buy/sell
      const tokenIn = orderType === 'buy' ? cashTokenAddress : securitiesTokenAddress;
      const tokenOut = orderType === 'buy' ? securitiesTokenAddress : cashTokenAddress;

      // Approve token spending
      const tokenContract = new Contract(tokenIn, ERC20_ABI, signer);
      const allowance = await tokenContract.allowance(address, orderbookAddress);

      if (allowance < amountIn) {
        const approveTx = await tokenContract.approve(orderbookAddress, amountIn);
        await approveTx.wait();
      }

      // Submit order
      const tx = await contract.submitOrder(tokenIn, tokenOut, amountIn, amountOut);
      const receipt = await tx.wait();

      setSuccess(`Order submitted successfully! Tx: ${receipt.hash.slice(0, 10)}...`);
      setAmount('');
      setPrice('');

      // Reload order book
      setTimeout(loadOrderHistory, 1000);
    } catch (err) {
      console.error('Error submitting order:', err);
      setError(err.message || 'Failed to submit order');
    } finally {
      setLoading(false);
    }
  };

  // Handle order cancellation
  const handleCancelOrder = async (orderId) => {
    if (!signer) {
      setError('Please connect your wallet');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const contract = new Contract(orderbookAddress, ORDERBOOK_ABI, signer);
      const tx = await contract.cancelOrder(orderId);
      await tx.wait();

      setSuccess('Order cancelled successfully!');
      setTimeout(loadOrderHistory, 1000);
    } catch (err) {
      console.error('Error cancelling order:', err);
      setError(err.message || 'Failed to cancel order');
    } finally {
      setLoading(false);
    }
  };

  // Get buy and sell orders
  const buyOrders = Array.from(orders.values())
    .filter(
      (order) =>
        order.status === ORDER_STATUS.OPEN &&
        order.tokenIn.toLowerCase() === cashTokenAddress.toLowerCase()
    )
    .sort((a, b) => {
      const priceA = Number(a.amountIn) / Number(a.amountOut);
      const priceB = Number(b.amountIn) / Number(b.amountOut);
      return priceB - priceA;
    });

  const sellOrders = Array.from(orders.values())
    .filter(
      (order) =>
        order.status === ORDER_STATUS.OPEN &&
        order.tokenIn.toLowerCase() === securitiesTokenAddress.toLowerCase()
    )
    .sort((a, b) => {
      const priceA = Number(a.amountOut) / Number(a.amountIn);
      const priceB = Number(b.amountOut) / Number(b.amountIn);
      return priceA - priceB;
    });

  if (!isConnected) {
    return (
      <div className="orderbook-page">
        <div className="container">
          <div className="welcome-card">
            <h1>Order Book</h1>
            <p>Connect your wallet to place and view orders</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="orderbook-page">
      <div className="container">
        <div className="orderbook-header">
          <h1>Order Book</h1>
          <p className="wallet-info">
            Connected: <code>{truncateAddress(address)}</code>
          </p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {!kycApproved && isConnected && (
          <div className="kyc-warning">
            ⚠️ KYC verification required before trading. <Link to="/kyc">Complete KYC</Link>
          </div>
        )}

        <div className="orderbook-grid">
          {/* Place Order Card */}
          <div className="card place-order-card">
            <div className="card-header">
              <h3>Place Order</h3>
            </div>
            <div className="card-body">
              <form onSubmit={handleSubmitOrder}>
                <div className="order-type-toggle">
                  <button
                    type="button"
                    className={`toggle-btn ${orderType === 'buy' ? 'active buy' : ''}`}
                    onClick={() => setOrderType('buy')}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    className={`toggle-btn ${orderType === 'sell' ? 'active sell' : ''}`}
                    onClick={() => setOrderType('sell')}
                  >
                    Sell
                  </button>
                </div>

                <div className="form-group">
                  <label>Amount of Securities</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={loading}
                  />
                </div>

                <div className="form-group">
                  <label>Price (Cash per Security)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="0.00"
                    disabled={loading}
                  />
                </div>

                {amount && price && (
                  <div className="total-cost">
                    <span>Total Cost:</span>
                    <span className="amount">
                      {(parseFloat(amount) * parseFloat(price)).toFixed(2)} Cash
                    </span>
                  </div>
                )}

                <button
                  type="submit"
                  className={`btn btn-primary btn-large ${orderType === 'buy' ? 'buy' : 'sell'}`}
                  disabled={loading || !amount || !price}
                >
                  {loading ? 'Submitting...' : `Place ${orderType.toUpperCase()} Order`}
                </button>
              </form>
            </div>
          </div>

          {/* Order Book Display */}
          <div className="card orderbook-display-card">
            <div className="card-header">
              <h3>Order Book</h3>
            </div>
            <div className="card-body">
              {bookLoading ? (
                <div className="loading">Loading order book...</div>
              ) : (
                <div className="orderbook-display">
                  <div className="orderbook-side buy-side">
                    <div className="side-header">Buy Orders (Bids)</div>
                    <div className="orderbook-table">
                      <div className="table-header">
                        <div className="col-price">Price</div>
                        <div className="col-amount">Amount</div>
                        <div className="col-trader">Trader</div>
                      </div>
                      {buyOrders.length > 0 ? (
                        buyOrders.map((order) => (
                          <div key={order.orderId.toString()} className="table-row">
                            <div className="col-price">
                              {(Number(order.amountIn) / Number(order.amountOut)).toFixed(4)}
                            </div>
                            <div className="col-amount">
                              {formatUnits(order.amountOut, 18).slice(0, 10)}
                            </div>
                            <div className="col-trader">{truncateAddress(order.trader)}</div>
                          </div>
                        ))
                      ) : (
                        <div className="no-orders">No buy orders</div>
                      )}
                    </div>
                  </div>

                  <div className="orderbook-side sell-side">
                    <div className="side-header">Sell Orders (Asks)</div>
                    <div className="orderbook-table">
                      <div className="table-header">
                        <div className="col-price">Price</div>
                        <div className="col-amount">Amount</div>
                        <div className="col-trader">Trader</div>
                      </div>
                      {sellOrders.length > 0 ? (
                        sellOrders.map((order) => (
                          <div key={order.orderId.toString()} className="table-row">
                            <div className="col-price">
                              {(Number(order.amountOut) / Number(order.amountIn)).toFixed(4)}
                            </div>
                            <div className="col-amount">
                              {formatUnits(order.amountIn, 18).slice(0, 10)}
                            </div>
                            <div className="col-trader">{truncateAddress(order.trader)}</div>
                          </div>
                        ))
                      ) : (
                        <div className="no-orders">No sell orders</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* My Orders Card */}
        <div className="card my-orders-card">
          <div className="card-header">
            <h3>My Orders</h3>
          </div>
          <div className="card-body">
            {myOrders.length > 0 ? (
              <div className="my-orders-table">
                <div className="table-header">
                  <div className="col-type">Type</div>
                  <div className="col-price">Price</div>
                  <div className="col-amount">Amount</div>
                  <div className="col-status">Status</div>
                  <div className="col-action">Action</div>
                </div>
                {myOrders.map((order) => {
                  const isBuy = order.tokenIn.toLowerCase() === cashTokenAddress.toLowerCase();
                  const price = isBuy
                    ? Number(order.amountIn) / Number(order.amountOut)
                    : Number(order.amountOut) / Number(order.amountIn);
                  const amountSecurities = isBuy ? order.amountOut : order.amountIn;
                  const statusText =
                    order.status === ORDER_STATUS.OPEN
                      ? 'Open'
                      : order.status === ORDER_STATUS.MATCHED
                        ? 'Matched'
                        : 'Cancelled';

                  return (
                    <div key={order.orderId.toString()} className="table-row">
                      <div className={`col-type ${isBuy ? 'buy' : 'sell'}`}>
                        {isBuy ? 'BUY' : 'SELL'}
                      </div>
                      <div className="col-price">{price.toFixed(4)}</div>
                      <div className="col-amount">{formatUnits(amountSecurities, 18).slice(0, 10)}</div>
                      <div className={`col-status status-${statusText.toLowerCase()}`}>{statusText}</div>
                      <div className="col-action">
                        {order.status === ORDER_STATUS.OPEN && (
                          <button
                            className="btn btn-small btn-danger"
                            onClick={() => handleCancelOrder(order.orderId)}
                            disabled={loading}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="no-orders">No orders yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
