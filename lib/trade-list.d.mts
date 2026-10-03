import type { NormalizedTrade, TradePnlResult } from "./trade.mjs";

export type TradeListSort = "date" | "holding" | "pnl";
export type TradeListDirection = "asc" | "desc";
type ListTrade = Partial<NormalizedTrade> & Pick<NormalizedTrade, "side" | "quantity" | "entryPrice" | "symbol"> & {
  openPosition?: { markPrice?: number };
};
export interface TradeListRow<T> {
  trade: T;
  pnl: TradePnlResult | null;
  holdingMs: number | null;
  tone: "profit" | "loss" | "neutral";
  intensity: number;
}
export function buildTradeListRows<T extends ListTrade>(trades: readonly T[], options?: {
  sortBy?: TradeListSort;
  direction?: TradeListDirection;
  now?: number;
}): TradeListRow<T>[];
export function formatTradeHoldingTime(milliseconds: number | null): string;
export function summarizeTradeListByToken(trades: readonly ListTrade[]): {
  token: string;
  count: number;
  totalPnl: number | null;
  hasOpenPositions: boolean;
}[];
