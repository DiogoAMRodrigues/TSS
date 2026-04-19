class SimulatedEidasProvider {
  constructor() {
    this.name = "simulated-eidas";
  }

  async verifyIdentity({ walletAddress, requestedRole, identityData }) {
    const normalizedRole = String(requestedRole || "TRADER").toUpperCase();
    const blocked = Boolean(identityData?.isSanctioned) || Boolean(identityData?.isPep);
    const hasIdentifier = Boolean(identityData?.identifier);

    if (!hasIdentifier) {
      return {
        approved: false,
        reason: "Missing identity identifier",
      };
    }

    if (blocked) {
      return {
        approved: false,
        reason: "Sanctions or PEP check failed",
      };
    }

    return {
      approved: true,
      role: normalizedRole,
      evidenceId: `SIM-${Date.now()}`,
      provider: this.name,
    };
  }
}

module.exports = SimulatedEidasProvider;
