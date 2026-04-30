import { useState } from 'react';
import { api } from '../services/api';
import './RevokeForm.css';

export function RevokeForm() {
  const [walletAddress, setWalletAddress] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleRevoke = async (e) => {
    e.preventDefault();

    if (!walletAddress.trim()) {
      setError('Please enter a wallet address');
      return;
    }

    if (!reason.trim()) {
      setError('Please enter a reason for revocation');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await api.revoke(walletAddress, reason);

      setSuccess(response.message || 'User revoked successfully');
      setWalletAddress('');
      setReason('');
    } catch (err) {
      setError(err.message || 'Failed to revoke user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="revoke-form-card">
      <div className="card-header">
        <h3>Revoke User</h3>
      </div>

      <div className="card-body">
        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {success && (
          <div className="alert alert-success">
            {success}
          </div>
        )}

        <form onSubmit={handleRevoke}>
          <div className="form-group">
            <label htmlFor="wallet-address">Wallet Address</label>
            <input
              id="wallet-address"
              type="text"
              placeholder="0x..."
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="reason">Reason for Revocation</label>
            <textarea
              id="reason"
              placeholder="Enter reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={loading}
              rows="4"
            />
          </div>

          <button
            type="submit"
            className="btn btn-danger"
            disabled={loading}
          >
            {loading ? 'Revoking...' : 'Revoke User'}
          </button>
        </form>
      </div>
    </div>
  );
}
