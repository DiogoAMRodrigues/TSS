/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';
import { api } from '../services/api';
import { KycStatusCard } from '../components/KycStatusCard';
import { KycFlow } from '../components/KycFlow';
import './UserDashboard.css';

export function UserDashboard() {
  const { isConnected, address } = useWallet();
  const [kycStatus, setKycStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchKycStatus = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await api.getUser(address);
      setKycStatus(response.local || {});
    } catch (err) {
      setError(err.message || 'Failed to fetch KYC status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected && address) {
      fetchKycStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  const handleVerificationComplete = () => {
    // Refresh status after verification
    setTimeout(fetchKycStatus, 1000);
  };

  if (!isConnected) {
    return (
      <div className="user-dashboard">
        <div className="container">
          <div className="welcome-card">
            <h1>Welcome to TSS</h1>
            <p>Tokenized Securities System - KYC Verification</p>
            <p className="description">
              Connect your MetaMask wallet to get started with KYC verification.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="user-dashboard">
      <div className="container">
        <div className="dashboard-header">
          <h1>KYC Verification Dashboard</h1>
          <p className="wallet-info">
            Connected wallet: <code>{address}</code>
          </p>
        </div>

        <KycStatusCard
          status={kycStatus?.status}
          role={kycStatus?.role}
          expiryDate={kycStatus?.expiryDate}
          loading={loading}
          error={error}
        />

        <KycFlow
          onVerificationComplete={handleVerificationComplete}
          onReverifyClick={fetchKycStatus}
        />

        {kycStatus?.status === 'approved' && (
          <div className="reverify-section">
            <p className="reverify-hint">
              Your KYC is currently approved. You can reverify at any time to update your information.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
