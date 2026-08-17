import type { TradeEntry, TradeExit, TradeSide } from "./trade.mjs";
import type { ReplayRiskLevel } from "./risk.mjs";

export type ReplaySyncSource =
  | "okx-api"
  | "binance-api"
  | "binance-csv"
  | "copy-trade-public"
  | "smart-money-public"
  | "ocr-basic"
  | "ocr-follow"
  | "ocr-condition"
  | "manual-csv"
  | "manual-json"
  | "built-in"
  | "simulation"
  | "legacy-import";

export interface BinanceUserTradeFill {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "BOTH" | "LONG" | "SHORT";
  price: number;
  quantity: number;
  quoteQuantity: number;
  commission: number;
  commissionAsset: string;
  realizedPnl: number;
  time: string;
  maker: boolean;
}

export interface BinanceFundingFee {
  userId: string;
  transactionId: string;
  symbol: string;
  incomeType: "FUNDING_FEE";
  amount: number;
  asset: string;
  time: string;
}

export interface BinanceOpenPosition {
  exchangeProvider?: "binance-usdm" | "okx-swap";
  userId: string;
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  breakEvenPrice: number | null;
  markPrice: number;
  unRealizedProfit: number;
  marginAsset: string;
  updateTime: string;
  fundingFeesKnown?: boolean;
  fundingFees?: BinanceFundingFee[];
  fundingFeeNotice?: string;
  syncedAt?: string | number | null;
  profileId?: string;
  profileName?: string;
}

export interface BinanceUsdmOrder {
  exchangeProvider?: "binance-usdm" | "okx-swap";
  userId: string;
  profileId?: string;
  profileName?: string;
  orderId: string;
  symbol: string;
  orderType: string;
  side: "BUY" | "SELL";
  limitPrice: number | null;
  averagePrice: number | null;
  originalQuantity: number;
  executedQuantity: number;
  executedQuoteQuantity: number;
  stopPrice: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  reduceOnly?: boolean;
  closePosition?: boolean;
  workingType?: string | null;
  sourceKind?: "api-normal" | "api-algo" | "okx-api-normal" | "okx-api-algo";
  source?: "ocr-basic" | "ocr-follow" | "copy-trade-public" | "smart-money-public" | string;
  actualOrderId?: string | null;
  algoStatus?: string;
  lifecycleTimeEstimated?: boolean;
  sourceOrderAliases?: string[];
  syncSources?: ReplaySyncSource[];
  fills?: BinanceUserTradeFill[];
  reportedRealizedPnl?: number | null;
}

export interface BinanceReconstructedReplay {
  id: string;
  sourceKey: string;
  profileId?: string;
  profileName?: string;
  sourceEntryOrderId: string;
  sourceEntryAliases: string[];
  sourceOrderIds: string[];
  syncSources: ReplaySyncSource[];
  title: string;
  strategy: string;
  notes: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  entryTime: string;
  stopLoss: null;
  takeProfit: null;
  exitPrice: number | null;
  exitTime: string | null;
  fee: number;
  entries: TradeEntry[];
  exits: TradeExit[];
  riskLevels: ReplayRiskLevel[];
  exitLabel: "平仓成交" | "未平仓";
  marketDataSource: "binance-futures";
  feesKnown: boolean;
  commissionByAsset: Record<string, number>;
  fundingFeesKnown?: boolean;
  fundingFees?: BinanceFundingFee[];
  fundingFee?: number;
  openPosition?: Omit<BinanceOpenPosition, "syncedAt"> & {
    syncedAt: string | null;
  };
  openPositionEvidence?: {
    source: "complete-order-history";
    syncedAt: string;
  };
  reconstructionNotice: string;
  reportedRealizedPnl?: number;
}

export interface BinanceReplayWarning {
  code: "ambiguous_open_position" | "missing_open_position_history";
  symbol: string;
  orderIds: string[];
  message: string;
}

export function isBinanceUsdmOrderHistoryCsv(input: unknown): boolean;
export function parseBinanceUsdmOrderHistoryCsv(input: string): BinanceUsdmOrder[];
export function reconstructBinanceUsdmReplays(
  orders: BinanceUsdmOrder[],
  options?: {
    openPositions?: BinanceOpenPosition[];
    syncedAt?: string | number | null;
    allowHistoryOnlyOpenPositions?: boolean;
  },
): {
  trades: BinanceReconstructedReplay[];
  warnings: BinanceReplayWarning[];
};
export function mergeBinanceOrderRecords(
  currentOrders: unknown,
  incomingOrders: unknown,
): BinanceUsdmOrder[];
export function mergeImportedReplays<T>(
  currentTrades: T[],
  incomingTrades: T[],
): T[];
export function mergeBinanceApiReplays<T>(
  currentTrades: T[],
  incomingTrades: T[],
  options?: { accountId?: string | null; profileId?: string | null },
): T[];
export function mergeOkxApiReplays<T>(
  currentTrades: T[],
  incomingTrades: T[],
  options?: { accountId?: string | null; profileId?: string | null },
): T[];
