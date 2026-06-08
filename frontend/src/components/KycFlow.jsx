import { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';
import { api } from '../services/api';
import './KycFlow.css';

export function KycFlow({ onVerificationComplete }) {
  const { address, signer } = useWallet();
  const [step, setStep] = useState(1);
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState('TRADER');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [challenge, setChallenge] = useState(null);

  // Pick up the ?kyc=approved|failed query string the middleware redirects to
  // after the AMA flow finishes. Once consumed, scrub it from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kyc = params.get('kyc');
    if (!kyc) return;
    if (kyc === 'approved') {
      const tx = params.get('tx');
      const wallet = params.get('wallet');
      const r = params.get('role');
      setSuccess(
        `KYC approved via Autenticação.gov — wallet ${wallet} whitelisted as ${r}` +
          (tx ? ` (tx ${tx.slice(0, 10)}…)` : '')
      );
      setStep(3);
      if (onVerificationComplete) onVerificationComplete();
    } else if (kyc === 'failed') {
      const reason = params.get('reason') || 'KYC failed';
      const status = params.get('status') || '';
      setError(`${reason}${status ? ` (HTTP ${status})` : ''}`);
    }
    // Strip query params from URL without reloading
    window.history.replaceState({}, document.title, window.location.pathname);
  }, [onVerificationComplete]);

  const handleStartKyc = async () => {
    if (!identifier.trim()) {
      setError('Please enter an identifier');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const response = await api.request(address, role, identifier);
      setChallenge(response.challengeMessage);
      setStep(2);
    } catch (err) {
      setError(err.message || 'Failed to start KYC');
    } finally {
      setLoading(false);
    }
  };

  const handleSignChallenge = async () => {
    if (!signer || !challenge) {
      setError('Signer or challenge not available');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const signature = await signer.signMessage(challenge);

      const response = await api.verify(address, signature);

      setSuccess(response.message || 'KYC verification successful!');
      setStep(3);

      if (onVerificationComplete) {
        onVerificationComplete();
      }
    } catch (err) {
      setError(err.message || 'Failed to sign challenge');
    } finally {
      setLoading(false);
    }
  };

  // Real eIDAS path: sign challenge with MetaMask, then redirect the browser
  // to /api/kyc/eidas/start. AMA Autenticação.gov takes over from there
  // (Cartão de Cidadão / Chave Móvel Digital), then POSTs back to the
  // middleware callback which whitelists the wallet on chain.
  const handleEidasFlow = async () => {
    if (!signer || !challenge) {
      setError('Signer or challenge not available');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const signature = await signer.signMessage(challenge);
      const url = api.eidasStartUrl(address, signature, role);
      window.location.href = url;
    } catch (err) {
      setError(err.message || 'Failed to start eIDAS flow');
      setLoading(false);
    }
  };

  const handleReset = () => {
    setStep(1);
    setIdentifier('');
    setRole('TRADER');
    setChallenge(null);
    setError(null);
    setSuccess(null);
  };

  return (
    <div className="kyc-flow-card">
      <div className="card-header">
        <h2>KYC Verification</h2>
        <div className="step-indicator">
          Step {step} of 3
        </div>
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

        {step === 1 && (
          <div className="step-content">
            <h3>Step 1: Enter Your Information</h3>

            <div className="form-group">
              <label htmlFor="identifier">Identifier (Email/ID)</label>
              <input
                id="identifier"
                type="text"
                placeholder="your-email@example.com or ID number"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="form-group">
              <label htmlFor="role">Role</label>
              <select
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={loading}
              >
                <option value="TRADER">Trader</option>
                <option value="ISSUER">Issuer</option>
              </select>
            </div>

            <button
              className="btn btn-primary btn-large"
              onClick={handleStartKyc}
              disabled={loading}
            >
              {loading ? 'Starting KYC...' : 'Start KYC'}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="step-content">
            <h3>Step 2: Sign Challenge</h3>

            <div className="challenge-box">
              <p className="challenge-label">Challenge Message:</p>
              <code className="challenge-text">{challenge}</code>
            </div>

            <p className="step-description">
              Sign this challenge with MetaMask to prove you control this wallet,
              then choose how to verify your identity.
            </p>

            <button
              className="btn btn-primary btn-large"
              onClick={handleEidasFlow}
              disabled={loading}
              title="Real eIDAS via AMA Autenticação.gov (Cartão de Cidadão / Chave Móvel Digital)"
            >
              {loading ? 'Working...' : 'Continue with Autenticação.gov (CC / CMD)'}
            </button>

            {import.meta.env.VITE_ALLOW_SIMULATED_KYC === 'true' && (
              <button
                className="btn btn-secondary btn-large"
                onClick={handleSignChallenge}
                disabled={loading}
                title="Simulated KYC — for development only"
              >
                {loading ? 'Signing...' : 'Use simulated KYC (dev only)'}
              </button>
            )}

            <button
              className="btn btn-secondary"
              onClick={handleReset}
              disabled={loading}
            >
              Back
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="step-content">
            <h3>Step 3: Complete</h3>

            <div className="success-icon">✓</div>

            <p className="step-description">
              Your KYC verification has been submitted. The status will be updated shortly.
            </p>

            <button
              className="btn btn-primary btn-large"
              onClick={handleReset}
            >
              Start New Verification
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
