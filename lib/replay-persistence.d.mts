export interface DesktopReplayPersistenceApi {
  saveOrders(orders: readonly unknown[]): Promise<void>;
  saveTrades(trades: readonly unknown[]): Promise<void>;
}

export function persistDesktopReplaySnapshot(
  desktopApi: DesktopReplayPersistenceApi,
  snapshot: {
    orders: readonly unknown[];
    trades: readonly unknown[];
  },
): Promise<void>;
