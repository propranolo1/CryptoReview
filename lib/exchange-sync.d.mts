export const INCREMENTAL_SYNC_OVERLAP_MS: number;

export function resolveExchangeSyncRange(input: {
  startTime: number;
  endTime: number;
  incremental?: boolean;
  lastSyncedAt?: number | null;
}): {
  requestedStartTime: number;
  startTime: number;
  endTime: number;
  incremental: boolean;
};

export function selectActiveBinanceOrders(
  orders: unknown,
  accountId: string,
): Array<{ symbol: string; orderId: string; kind: "normal" | "algo" }>;
