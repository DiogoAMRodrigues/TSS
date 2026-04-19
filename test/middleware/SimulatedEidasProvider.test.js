const { expect } = require("chai");
const SimulatedEidasProvider = require("../../middleware/src/providers/simulatedEidasProvider");

describe("Middleware: SimulatedEidasProvider", function () {
  let provider;

  beforeEach(function () {
    provider = new SimulatedEidasProvider();
  });

  it("approves a valid identity payload", async function () {
    const result = await provider.verifyIdentity({
      walletAddress: "0x0000000000000000000000000000000000000001",
      requestedRole: "TRADER",
      identityData: { identifier: "citizen-123" },
    });

    expect(result.approved).to.equal(true);
    expect(result.role).to.equal("TRADER");
    expect(result.provider).to.equal("simulated-eidas");
    expect(result.evidenceId).to.match(/^SIM-/);
  });

  it("normalizes lowercase role to uppercase", async function () {
    const result = await provider.verifyIdentity({
      walletAddress: "0x0000000000000000000000000000000000000001",
      requestedRole: "issuer",
      identityData: { identifier: "citizen-123" },
    });

    expect(result.approved).to.equal(true);
    expect(result.role).to.equal("ISSUER");
  });

  it("defaults to TRADER role when none is supplied", async function () {
    const result = await provider.verifyIdentity({
      walletAddress: "0x0000000000000000000000000000000000000001",
      identityData: { identifier: "citizen-123" },
    });

    expect(result.approved).to.equal(true);
    expect(result.role).to.equal("TRADER");
  });

  it("rejects when identity identifier is missing", async function () {
    const result = await provider.verifyIdentity({
      walletAddress: "0x0000000000000000000000000000000000000001",
      requestedRole: "TRADER",
      identityData: {},
    });

    expect(result.approved).to.equal(false);
    expect(result.reason).to.equal("Missing identity identifier");
  });

  it("rejects sanctioned user", async function () {
    const result = await provider.verifyIdentity({
      walletAddress: "0x0000000000000000000000000000000000000001",
      requestedRole: "TRADER",
      identityData: { identifier: "citizen-123", isSanctioned: true },
    });

    expect(result.approved).to.equal(false);
    expect(result.reason).to.equal("Sanctions or PEP check failed");
  });

  it("rejects PEP user", async function () {
    const result = await provider.verifyIdentity({
      walletAddress: "0x0000000000000000000000000000000000000001",
      requestedRole: "TRADER",
      identityData: { identifier: "citizen-123", isPep: true },
    });

    expect(result.approved).to.equal(false);
    expect(result.reason).to.equal("Sanctions or PEP check failed");
  });
});
