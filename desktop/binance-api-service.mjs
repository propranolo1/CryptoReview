/** 协调凭证保险库、只读 Binance 客户端与本地订单存档。 */
export function createBinanceApiService({ repository, vault, client }) {
  if (
    !repository ||
    typeof repository.saveExchangeSyncSnapshot !== "function"
  ) {
    throw new TypeError("桌面交易所同步快照仓库不可用");
  }
  if (!vault || typeof vault.read !== "function") {
    throw new TypeError("Binance 凭证保险库不可用");
  }
  if (!client || typeof client.syncOrders !== "function") {
    throw new TypeError("Binance U 本位客户端不可用");
  }
  let syncInProgress = false;

  return {
    getStatus() {
      return vault.getStatus();
    },

    async configure(credentials) {
      const identity = await client.validateCredentials(credentials);
      return vault.save({ ...credentials, ...identity });
    },

    remove() {
      if (syncInProgress) throw new Error("订单同步进行中，暂时无法断开 Binance API");
      return vault.remove();
    },

    async syncOrders(options) {
      if (syncInProgress) throw new Error("Binance 订单同步正在进行，请等待当前任务完成");
      syncInProgress = true;
      try {
        const credentials = vault.read();
        const result = await client.syncOrders({
          ...options,
          ...credentials,
        });
        repository.saveExchangeSyncSnapshot({
          provider: "binance-usdm",
          accountId: credentials.accountId,
          orders: result.orders,
          openPositions: result.openPositions ?? [],
          syncedAt: result.syncedAt,
        });
        const status = vault.markSynced(result.syncedAt);
        return { ...result, accountId: credentials.accountId, status };
      } finally {
        syncInProgress = false;
      }
    },
  };
}
