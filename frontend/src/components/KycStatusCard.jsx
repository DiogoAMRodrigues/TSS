import './KycStatusCard.css';

export function KycStatusCard({ status, role, expiryDate, loading, error }) {
  const getStatusColor = (status) => {
    switch (status) {
      case 'approved':
        return 'status-approved';
      case 'pending':
        return 'status-pending';
      case 'revoked':
        return 'status-revoked';
      default:
        return 'status-not-started';
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'approved':
        return 'Approved';
      case 'pending':
        return 'Pending';
      case 'revoked':
        return 'Revoked';
      default:
        return 'Not Started';
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

  if (loading) {
    return (
      <div className="kyc-status-card">
        <div className="card-loading">Loading KYC status...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="kyc-status-card">
        <div className="card-error">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="kyc-status-card">
      <div className="card-header">
        <h2>KYC Status</h2>
      </div>

      <div className="card-body">
        <div className="status-row">
          <span className="label">Status:</span>
          <span className={`status-badge ${getStatusColor(status)}`}>
            {getStatusLabel(status)}
          </span>
        </div>

        {role && (
          <div className="status-row">
            <span className="label">Role:</span>
            <span className="role-badge">{role}</span>
          </div>
        )}

        {expiryDate && status === 'approved' && (
          <div className="status-row">
            <span className="label">Expires:</span>
            <span className="expiry-date">{formatDate(expiryDate)}</span>
          </div>
        )}

        {!status || status === 'not-started' && (
          <div className="status-row">
            <span className="label">Action:</span>
            <span className="action-hint">Start KYC verification below</span>
          </div>
        )}
      </div>
    </div>
  );
}
