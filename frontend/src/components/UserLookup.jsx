import { useState } from 'react';
import { api } from '../services/api';
import './UserLookup.css';

export function UserLookup() {
  const [walletAddress, setWalletAddress] = useState('');
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  const handleLookup = async (e) => {
    e.preventDefault();

    if (!walletAddress.trim()) {
      setError('Please enter a wallet address');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setUserData(null);

      const response = await api.getUser(walletAddress);
      setUserData(response);
      setSearched(true);
    } catch (err) {
      setError(err.message || 'Failed to lookup user');
      setUserData(null);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return dateString;
    }
  };

  return (
    <div className="user-lookup-card">
      <div className="card-header">
        <h3>User Lookup</h3>
      </div>

      <div className="card-body">
        <form onSubmit={handleLookup}>
          <div className="form-group">
            <label htmlFor="wallet-lookup">Wallet Address</label>
            <div className="input-group">
              <input
                id="wallet-lookup"
                type="text"
                placeholder="0x..."
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                disabled={loading}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>
        </form>

        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {searched && !error && !userData && (
          <div className="alert alert-info">
            No user found for this address
          </div>
        )}

        {userData && (
          <div className="user-data">
            <div className="data-section">
              <h4>Local Data</h4>
              <div className="data-row">
                <span className="label">Wallet:</span>
                <span className="value monospace">{userData.local?.walletAddress || 'N/A'}</span>
              </div>
              <div className="data-row">
                <span className="label">Status:</span>
                <span className={`status-badge status-${userData.local?.status?.toLowerCase()}`}>
                  {userData.local?.status || 'N/A'}
                </span>
              </div>
              <div className="data-row">
                <span className="label">Role:</span>
                <span className="value">{userData.local?.role || 'N/A'}</span>
              </div>
              <div className="data-row">
                <span className="label">Created:</span>
                <span className="value">{formatDate(userData.local?.createdAt)}</span>
              </div>
              <div className="data-row">
                <span className="label">Updated:</span>
                <span className="value">{formatDate(userData.local?.updatedAt)}</span>
              </div>
            </div>

            {userData.onChain && (
              <div className="data-section">
                <h4>On-Chain Data</h4>
                <div className="data-row">
                  <span className="label">Whitelisted:</span>
                  <span className="value">
                    {userData.onChain.whitelisted ? (
                      <span className="badge badge-success">Yes</span>
                    ) : (
                      <span className="badge badge-danger">No</span>
                    )}
                  </span>
                </div>
                <div className="data-row">
                  <span className="label">Role:</span>
                  <span className="value">{userData.onChain.role || 'N/A'}</span>
                </div>
                <div className="data-row">
                  <span className="label">Expired:</span>
                  <span className="value">
                    {userData.onChain.expired ? (
                      <span className="badge badge-danger">Yes</span>
                    ) : (
                      <span className="badge badge-success">No</span>
                    )}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
