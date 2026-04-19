const { expect } = require("chai");

const { reconcileIdentityEvents } = require("../../middleware/src/services/reconciliationService");
const { resetStore, users, getMeta } = require("../../middleware/src/state/store");

describe("Middleware: reconciliation service", function () {
  beforeEach(function () {
    resetStore();
  });

  it("reconciles whitelist, revoke, and attestation events into local store", async function () {
    const identityClient = {
      provider: {
        getBlockNumber: async () => 20,
      },
      contract: {
        filters: {
          UserWhitelisted: () => ({ type: "whitelisted" }),
          UserRevoked: () => ({ type: "revoked" }),
          AttestationUpdated: () => ({ type: "attestation" }),
        },
        queryFilter: async (filter) => {
          if (filter.type === "whitelisted") {
            return [
              {
                args: { user: "0x0000000000000000000000000000000000000001" },
                blockNumber: 12,
              },
            ];
          }
          if (filter.type === "revoked") {
            return [
              {
                args: { user: "0x0000000000000000000000000000000000000002" },
                blockNumber: 13,
              },
            ];
          }
          if (filter.type === "attestation") {
            return [
              {
                args: {
                  user: "0x0000000000000000000000000000000000000001",
                  expiry: 999999,
                },
                blockNumber: 14,
              },
            ];
          }
          return [];
        },
      },
    };

    const result = await reconcileIdentityEvents(identityClient);

    expect(result.processed).to.equal(3);
    expect(result.toBlock).to.equal(20);

    const approvedUser = users.get("0x0000000000000000000000000000000000000001");
    expect(approvedUser.kycStatus).to.equal("approved");
    expect(approvedUser.attestationExpiryUnixSeconds).to.equal(999999);

    const revokedUser = users.get("0x0000000000000000000000000000000000000002");
    expect(revokedUser.kycStatus).to.equal("revoked");

    expect(getMeta().lastProcessedBlock).to.equal(20);
  });

  it("does nothing when no new blocks are available", async function () {
    const identityClient = {
      provider: {
        getBlockNumber: async () => 0,
      },
      contract: {
        filters: {
          UserWhitelisted: () => ({}),
          UserRevoked: () => ({}),
          AttestationUpdated: () => ({}),
        },
        queryFilter: async () => [],
      },
    };

    const result = await reconcileIdentityEvents(identityClient);
    expect(result.processed).to.equal(0);
  });
});
