import { useState, useEffect } from 'react';
import { api } from '../services/api';
import './UserList.css';

export function UserList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.listUsers();
      setUsers(response.users || []);
    } catch (err) {
      setError(err.message || 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const getStatusBadge = (status) => {
    switch (status) {
      case 'approved': return 'badge-approved';
      case 'pending': return 'badge-pending';
      case 'revoked': return 'badge-revoked';
      default: return 'badge-unknown';
    }
  };

  const truncateAddress = (addr) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="user-list-card">
      <div className="card-header">
        <h3>Registered Users</h3>
        <button className="btn btn-sm" onClick={fetchUsers} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div className="card-body">
        {error && <div className="alert alert-error">{error}</div>}

        {!loading && users.length === 0 && !error && (
          <p className="empty-state">No registered users yet.</p>
        )}

        {users.length > 0 && (
          <div className="user-table-wrapper">
            <table className="user-table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Role</th>
                  <th>KYC Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.walletAddress}>
                    <td className="wallet-cell" title={user.walletAddress}>
                      <code>{user.walletAddress}</code>
                    </td>
                    <td>{user.role || '—'}</td>
                    <td>
                      <span className={`status-badge ${getStatusBadge(user.kycStatus)}`}>
                        {user.kycStatus || 'unknown'}
                      </span>
                    </td>
                    <td>{user.updatedAt ? new Date(user.updatedAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
