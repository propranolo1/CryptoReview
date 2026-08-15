import type {
  BinanceOpenPosition,
  BinanceUsdmOrder,
} from "./binance-orders.mjs";

export type CopyTradeMonitorInterval = 30 | 60 | 300;

export interface PublicLeadPositionSnapshot {
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
}

export interface StoredPublicLeadSnapshot {
  fetchedAt: string;
  positions: PublicLeadPositionSnapshot[];
}

export interface CopyTradeMonitorConfig {
  enabled: boolean;
  sourceUrl: string;
  portfolioId: string;
  intervalSeconds: CopyTradeMonitorInterval;
  nickname?: string;
  lastSyncedAt?: string;
  lastAttemptAt?: string;
  lastOrderTime?: number;
  lastSnapshot?: StoredPublicLeadSnapshot;
  lastError?: string;
}

export interface PublicLeadSnapshot {
  portfolioId: string;
  fetchedAt: string;
  nickname: string | null;
  status: string | null;
  totalOrders: number;
  orders: Array<{
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    positionSide: "BOTH" | "LONG" | "SHORT";
    executedQty: number;
    avgPrice: number;
    totalPnl: number;
    orderUpdateTime: number;
    orderTime: number;
  }>;
  positions: Array<PublicLeadPositionSnapshot & {
    side: "long" | "short";
    breakEvenPrice: number | null;
    markPrice: number;
    unRealizedProfit: number;
    marginAsset: string;
  }>;
  warnings: string[];
}

export interface PublicLeadPositionChange {
  kind: "opened" | "increased" | "reduced" | "closed";
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  previousQuantity: number;
  quantity: number;
  detectedAt: string;
}

export function extractLeadPortfolioId(input: unknown): string;
export function normalizeCopyTradeMonitorConfig(
  value: unknown,
): CopyTradeMonitorConfig | null;
export function normalizePublicLeadSnapshot(
  input: unknown,
  options?: { portfolioId?: string; fetchedAt?: string | number },
): PublicLeadSnapshot;
export function createPublicLeadOrderRecords(
  input: unknown,
  options: {
    portfolioId?: string;
    profileId: string;
    profileName: string;
    source?: "copy-trade-public" | "smart-money-public";
    sourceIdentity?: string;
  },
): BinanceUsdmOrder[];
export function createPublicLeadOpenPositions(
  input: unknown,
  options: {
    portfolioId?: string;
    profileId: string;
    profileName: string;
    source?: "copy-trade-public" | "smart-money-public";
    sourceIdentity?: string;
  },
): BinanceOpenPosition[];
export function diffPublicLeadSnapshots(
  previous: unknown,
  next: unknown,
): PublicLeadPositionChange[];
export function createStoredPublicLeadSnapshot(
  snapshot: unknown,
): StoredPublicLeadSnapshot;
