import { useState } from 'react';
import { api } from '../services/api';
import { RevokeForm } from '../components/RevokeForm';
import { AuditLog } from '../components/AuditLog';
import { UserLookup } from '../components/UserLookup';
import { UserList } from '../components/UserList';
import './AdminPanel.css';

export function AdminPanel() {
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileError, setReconcileError] = useState(null);
  const [reconcileSuccess, setReconcileSuccess] = useState(null);

  const handleReconcile = async () => {
    try {
      setReconcileLoading(true);
      setReconcileError(null);
      setReconcileSuccess(null);

      const response = await api.reconcile();
      setReconcileSuccess(response.message || 'Reconciliation completed successfully');
    } catch (err) {
      setReconcileError(err.message || 'Failed to reconcile');
    } finally {
      setReconcileLoading(false);
    }
  };

  return (
    <div className="admin-panel">
      <div className="container">
        <div className="admin-header">
          <h1>Admin Panel</h1>
          <p className="admin-description">
            Manage KYC users, audit logs, and system operations
          </p>
        </div>

        <div className="admin-grid">
          <div className="admin-section full-width">
            <UserList />
          </div>

          <div className="admin-section">
            <RevokeForm />
          </div>

          <div className="admin-section">
            <UserLookup />
          </div>

          <div className="admin-section">
            <div className="reconcile-card">
              <div className="card-header">
                <h3>System Reconciliation</h3>
              </div>

              <div className="card-body">
                {reconcileError && (
                  <div className="alert alert-error">
                    {reconcileError}
                  </div>
                )}

                {reconcileSuccess && (
                  <div className="alert alert-success">
                    {reconcileSuccess}
                  </div>
                )}

                <p className="reconcile-description">
                  Reconcile local and on-chain KYC states. This operation syncs user statuses between the middleware database and the blockchain.
                </p>

                <button
                  className="btn btn-primary btn-large"
                  onClick={handleReconcile}
                  disabled={reconcileLoading}
                >
                  {reconcileLoading ? 'Reconciling...' : 'Start Reconciliation'}
                </button>
              </div>
            </div>
          </div>

          <div className="admin-section full-width">
            <AuditLog />
          </div>
        </div>
      </div>
    </div>
  );
}
