const { toKey, users, writeAudit, getMeta, setLastProcessedBlock, persistNow } = require("../state/store");

async function reconcileIdentityEvents(identityClient) {
  const latestBlock = await identityClient.provider.getBlockNumber();
  const { lastProcessedBlock } = getMeta();

  if (latestBlock <= lastProcessedBlock) {
    return { latestBlock, processed: 0 };
  }

  const fromBlock = Math.max(0, lastProcessedBlock + 1);
  const toBlock = latestBlock;

  const whitelistedEvents = await identityClient.contract.queryFilter(
    identityClient.contract.filters.UserWhitelisted(),
    fromBlock,
    toBlock
  );
  const revokedEvents = await identityClient.contract.queryFilter(
    identityClient.contract.filters.UserRevoked(),
    fromBlock,
    toBlock
  );
  const attestationEvents = await identityClient.contract.queryFilter(
    identityClient.contract.filters.AttestationUpdated(),
    fromBlock,
    toBlock
  );

  for (const evt of whitelistedEvents) {
    const walletAddress = evt.args.user;
    const key = toKey(walletAddress);
    const existing = users.get(key) || {};
    users.set(key, {
      ...existing,
      walletAddress,
      kycStatus: "approved",
      updatedAt: new Date().toISOString(),
      lastSyncedBlock: evt.blockNumber,
    });
    writeAudit({ action: "reconcile_whitelisted", walletAddress, blockNumber: evt.blockNumber });
  }

  for (const evt of revokedEvents) {
    const walletAddress = evt.args.user;
    const key = toKey(walletAddress);
    const existing = users.get(key) || {};
    users.set(key, {
      ...existing,
      walletAddress,
      kycStatus: "revoked",
      updatedAt: new Date().toISOString(),
      lastSyncedBlock: evt.blockNumber,
    });
    writeAudit({ action: "reconcile_revoked", walletAddress, blockNumber: evt.blockNumber });
  }

  for (const evt of attestationEvents) {
    const walletAddress = evt.args.user;
    const key = toKey(walletAddress);
    const existing = users.get(key) || {};
    users.set(key, {
      ...existing,
      walletAddress,
      attestationExpiryUnixSeconds: Number(evt.args.expiry),
      updatedAt: new Date().toISOString(),
      lastSyncedBlock: evt.blockNumber,
    });
    writeAudit({ action: "reconcile_attestation", walletAddress, blockNumber: evt.blockNumber });
  }

  setLastProcessedBlock(toBlock);
  persistNow();

  return {
    latestBlock,
    processed:
      whitelistedEvents.length + revokedEvents.length + attestationEvents.length,
    fromBlock,
    toBlock,
  };
}

function createReconciliationService(identityClient) {
  let timer = null;

  function start(intervalMs) {
    const value = Number(intervalMs);
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(async () => {
      try {
        await reconcileIdentityEvents(identityClient);
      } catch (error) {
        writeAudit({ action: "reconcile_error", error: error.message });
      }
    }, value);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    reconcileOnce: () => reconcileIdentityEvents(identityClient),
  };
}

module.exports = {
  reconcileIdentityEvents,
  createReconciliationService,
};
