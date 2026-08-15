import type { NormalizedTrade, TradeSide } from "./trade.mjs";

export interface SettlementCandle {
  time: number;
  open: number;
  close: number;
  closeTime?: number;
}

export function createSettlementTrade(options: {
  symbol: string;
  side: TradeSide;
  quantity: number;
  candles: SettlementCandle[];
  stopLoss?: number | null;
  takeProfit?: number | null;
  entryFee?: number;
  exitFee?: number;
}): NormalizedTrade;

export function mergeDefaultAndImportedTrades<T extends { id: string }>(
  defaultTrades: T[],
  savedTrades: unknown,
): T[];
