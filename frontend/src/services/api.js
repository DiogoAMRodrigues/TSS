const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY || 'dev-key';
const DEBUG = import.meta.env.VITE_DEBUG === 'true';

const log = (...args) => { if (DEBUG) console.log('[api]', ...args); };

const getHeaders = () => ({
  'Content-Type': 'application/json',
  'x-api-key': API_KEY
});

export const api = {
  // Health check (no auth needed)
  async health() {
    const res = await fetch(`${API_URL}/api/kyc/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.statusText}`);
    return res.json();
  },

  // Request KYC verification
  async request(walletAddress, requestedRole, identifier) {
    const res = await fetch(`${API_URL}/api/kyc/request`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        walletAddress,
        requestedRole,
        identityData: { identifier }
      })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || `Request failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Verify with signature
  async verify(walletAddress, signature, attestationDays = 365) {
    const res = await fetch(`${API_URL}/api/kyc/verify`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        walletAddress,
        signature,
        attestationDays
      })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || `Verification failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Reverify
  async reverify(walletAddress, requestedRole, identifier, attestationDays = 365) {
    const res = await fetch(`${API_URL}/api/kyc/reverify`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        walletAddress,
        requestedRole,
        identityData: { identifier },
        attestationDays
      })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || `Reverification failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Revoke user (OPERATOR only)
  async revoke(walletAddress, reason) {
    const res = await fetch(`${API_URL}/api/kyc/revoke`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        walletAddress,
        reason
      })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || `Revoke failed: ${res.statusText}`);
    }
    return res.json();
  },

  // List all users (OPERATOR/REGULATOR)
  async listUsers() {
    const res = await fetch(`${API_URL}/api/kyc/users`, {
      headers: getHeaders()
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || error.message || `User list failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Get user status
  async getUser(walletAddress) {
    const url = `${API_URL}/api/kyc/users/${walletAddress}`;
    log('GET', url, 'key:', API_KEY);
    const res = await fetch(url, {
      headers: getHeaders()
    });
    log('GET', url, '→', res.status, res.statusText);
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      log('Error body:', error);
      throw new Error(error.error || error.message || `User lookup failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Get audit log
  async getAudit(offset = 0, limit = 20) {
    const res = await fetch(`${API_URL}/api/kyc/audit?offset=${offset}&limit=${limit}`, {
      headers: getHeaders()
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || `Audit fetch failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Reconcile (OPERATOR only)
  async reconcile() {
    const res = await fetch(`${API_URL}/api/kyc/reconcile`, {
      method: 'POST',
      headers: getHeaders()
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || `Reconcile failed: ${res.statusText}`);
    }
    return res.json();
  }
};
