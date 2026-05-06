import { Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import './Navbar.css';

export function Navbar() {
  const { address, isConnected, connectWallet, disconnectWallet, isConnecting } = useWallet();

  const truncateAddress = (addr) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/" className="navbar-brand">
          TSS - Tokenized Securities System
        </Link>

        <div className="navbar-links">
          <Link to="/" className="nav-link">Dashboard</Link>
          <Link to="/amm" className="nav-link">AMM</Link>
          <Link to="/orderbook" className="nav-link">Order Book</Link>
          <Link to="/portfolio" className="nav-link">Portfolio</Link>
          <Link to="/kyc" className="nav-link">KYC</Link>
          <Link to="/admin" className="nav-link">Admin</Link>
        </div>

        <div className="navbar-right">
          {isConnected && (
            <span className="wallet-address" title={address}>
              {truncateAddress(address)}
            </span>
          )}
          {isConnected ? (
            <button
              className="btn btn-secondary"
              onClick={disconnectWallet}
              disabled={isConnecting}
            >
              Disconnect
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={connectWallet}
              disabled={isConnecting}
            >
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
