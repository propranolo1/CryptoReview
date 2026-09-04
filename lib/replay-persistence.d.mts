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

export interface ReplayStarredTrade {
  id: string;
  starred?: boolean;
}

export function filterStarredReplayTrades<T extends ReplayStarredTrade>(
  trades: readonly T[],
): T[];

export function toggleReplayTradeStar<T extends ReplayStarredTrade>(
  trades: readonly T[],
  tradeId: string,
): T[];

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
