import AMMPage from './AMMPage';
import { OrderBookPage } from './OrderBookPage';

const tradingMode = import.meta.env.VITE_TRADING_MODE || 'ob';

export function TradePage() {
  if (tradingMode === 'amm') {
    return <AMMPage />;
  }
  return <OrderBookPage />;
}
