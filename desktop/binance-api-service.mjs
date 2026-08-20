import {
  resolveExchangeSyncRange,
  selectActiveBinanceOrders,
} from "../lib/exchange-sync.mjs";

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
        const syncRange = resolveExchangeSyncRange({
          ...options,
          lastSyncedAt: options?.incremental
            ? vault.getStatus?.().lastSyncedAt ?? null
            : null,
        });
        const archivedOrders = syncRange.incremental
          ? repository.loadState?.().orders ?? []
          : [];
        const knownActiveOrders = selectActiveBinanceOrders(
          archivedOrders,
          credentials.accountId,
        );
        const result = await client.syncOrders({
          ...options,
          startTime: syncRange.startTime,
          endTime: syncRange.endTime,
          // 历史范围只从本次流水、持仓、挂单和当前账户活动订单发现交易对，
          // 避免把其他账户或其他交易所的旧币对带入每轮查询。
          symbols: [],
          knownActiveOrders,
          ...credentials,
        });
        options?.onProgress?.({ stage: "saving", message: "正在保存同步快照" });
        repository.saveExchangeSyncSnapshot({
          provider: "binance-usdm",
          accountId: credentials.accountId,
          orders: result.orders,
          openPositions: result.openPositions ?? [],
          syncedAt: result.syncedAt,
        });
        const status = vault.markSynced(result.syncedAt);
        options?.onProgress?.({ stage: "complete", message: "Binance 更新完成" });
        return {
          ...result,
          accountId: credentials.accountId,
          status,
          syncMode: syncRange.incremental ? "incremental" : "full",
          requestedStartTime: syncRange.requestedStartTime,
          effectiveStartTime: syncRange.startTime,
        };
      } finally {
        syncInProgress = false;
      }
    },
  };
}
