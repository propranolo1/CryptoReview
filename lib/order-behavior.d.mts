import type { BinanceUsdmOrder } from "./binance-orders.mjs";
export interface OrderAmendmentHistory {
  status: "complete" | "partial" | "unavailable";
  checkedAt: string;
  changes: { amendmentId: string; time: string; beforePrice: number; afterPrice: number }[];
}
export interface OrderBehaviorOptions { rapidFillMs?: number; longWaitMs?: number; asOfTime?: number; }
export interface OrderBehavior {
  orderId: string;
  provider: "binance-usdm" | "okx-swap" | null;
  side: string; orderType: string; createdAt: string | null;
  firstFillTime: string | null; waitMs: number | null;
  lastPriceChangeTime: string | null; lastChangeWaitMs: number | null;
  kind: string; label: string; explanation: string;
}
export interface OrderBehaviorTrade {
  symbol: string; sourceAccountId?: string; profileId?: string; syncSources?: string[];
  sourceEntryOrderId?: string; entryTime?: string | null; entries?: { sourceOrderId: string; entryTime?: string }[];
  openPosition?: { userId: string };
}
export function analyzeApiOrderBehavior(order: BinanceUsdmOrder | null, options?: OrderBehaviorOptions): OrderBehavior;
export function getTradeEntryOrderBehaviors(trade: OrderBehaviorTrade, orders: BinanceUsdmOrder[], options?: OrderBehaviorOptions): OrderBehavior[];
