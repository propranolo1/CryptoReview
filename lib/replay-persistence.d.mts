export interface DesktopReplayPersistenceApi {
  saveReplaySnapshot(snapshot: {
    orders: readonly unknown[];
    trades: readonly unknown[];
  }): Promise<void>;
}

export function persistDesktopReplaySnapshot(
  desktopApi: DesktopReplayPersistenceApi,
  snapshot: {
    orders: readonly unknown[];
    trades: readonly unknown[];
  },
): Promise<void>;

export interface ReplayTradeRecordRemoval<TOrder = unknown, TTrade = unknown> {
  orders: TOrder[];
  trades: TTrade[];
  removedTrade: TTrade;
  removedOrderCount: number;
}

export function removeReplayTradeRecord<TOrder, TTrade>(
  orders: readonly TOrder[],
  trades: readonly TTrade[],
  tradeId: string,
): ReplayTradeRecordRemoval<TOrder, TTrade>;
