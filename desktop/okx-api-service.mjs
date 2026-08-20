import { resolveExchangeSyncRange } from "../lib/exchange-sync.mjs";

/** 协调 OKX 凭证保险库、只读客户端与本地订单存档。 */
export function createOkxApiService({ repository, vault, client }) {
  if (
    !repository ||
    typeof repository.saveExchangeSyncSnapshot !== "function"
  ) {
    throw new TypeError("桌面交易所同步快照仓库不可用");
  }
  if (!vault || typeof vault.read !== "function") {
    throw new TypeError("OKX 凭证保险库不可用");
  }
  if (!client || typeof client.syncOrders !== "function") {
    throw new TypeError("OKX 永续合约客户端不可用");
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
      if (syncInProgress) throw new Error("订单同步进行中，暂时无法断开 OKX API");
      return vault.remove();
    },

    async syncOrders(options) {
      if (syncInProgress) throw new Error("OKX 订单同步正在进行，请等待当前任务完成");
      syncInProgress = true;
      try {
        const credentials = vault.read();
        const syncRange = resolveExchangeSyncRange({
          ...options,
          lastSyncedAt: options?.incremental
            ? vault.getStatus?.().lastSyncedAt ?? null
            : null,
        });
        const result = await client.syncOrders({
          ...options,
          startTime: syncRange.startTime,
          endTime: syncRange.endTime,
          ...credentials,
        });
        options?.onProgress?.({ stage: "saving", message: "正在保存同步快照" });
        repository.saveExchangeSyncSnapshot({
          provider: "okx-swap",
          accountId: credentials.accountId,
          orders: result.orders,
          openPositions: result.openPositions ?? [],
          syncedAt: result.syncedAt,
        });
        const status = vault.markSynced(result.syncedAt);
        options?.onProgress?.({ stage: "complete", message: "OKX 更新完成" });
        return {
          ...result,
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
