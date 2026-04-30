/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import './AuditLog.css';

export function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchAuditLog = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await api.getAudit(offset, limit);
      setEntries(response.entries || []);
      setTotal(response.total || 0);
    } catch (err) {
      setError(err.message || 'Failed to fetch audit log');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, limit]);

  const handlePrevious = () => {
    setOffset(Math.max(0, offset - limit));
  };

  const handleNext = () => {
    if (offset + limit < total) {
      setOffset(offset + limit);
    }
  };

  const formatDate = (dateString) => {
    try {
      return new Date(dateString).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return dateString;
    }
  };

  const truncateAddress = (addr) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  if (loading && entries.length === 0) {
    return (
      <div className="audit-log-card">
        <div className="card-header">
          <h3>Audit Log</h3>
        </div>
        <div className="card-body">
          <div className="loading">Loading audit log...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="audit-log-card">
      <div className="card-header">
        <h3>Audit Log</h3>
      </div>

      <div className="card-body">
        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {entries.length === 0 ? (
          <div className="empty-state">No audit entries found</div>
        ) : (
          <>
            <div className="table-wrapper">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Wallet</th>
                    <th>Action</th>
                    <th>Status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, idx) => (
                    <tr key={idx}>
                      <td className="timestamp">
                        {formatDate(entry.timestamp)}
                      </td>
                      <td className="wallet" title={entry.walletAddress}>
                        {truncateAddress(entry.walletAddress)}
                      </td>
                      <td className="action">
                        {entry.action}
                      </td>
                      <td className="status">
                        <span className={`status-badge status-${entry.status?.toLowerCase()}`}>
                          {entry.status}
                        </span>
                      </td>
                      <td className="details">
                        {entry.details || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <button
                className="btn btn-secondary"
                onClick={handlePrevious}
                disabled={offset === 0 || loading}
              >
                ← Previous
              </button>

              <span className="pagination-info">
                Showing {offset + 1} to {Math.min(offset + limit, total)} of {total}
              </span>

              <button
                className="btn btn-secondary"
                onClick={handleNext}
                disabled={offset + limit >= total || loading}
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
