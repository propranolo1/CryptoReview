export type TradeSide = "long" | "short";

export interface TradeExit {
  quantity: number;
  exitPrice: number;
  exitTime: string | null;
  fee: number;
}

export interface TradeEntry {
  id: string;
  sourceOrderId: string;
  quantity: number;
  entryPrice: number;
  entryTime: string;
  fee: number;
}

export interface NormalizedTrade {
  symbol: string;
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  entryTime: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  exitPrice: number | null;
  exitTime: string | null;
  fee: number;
  fundingFee?: number;
  entries?: TradeEntry[];
  exits: TradeExit[];
}

export interface TradePnlResult {
  entryNotional: number;
  exitedQuantity: number;
  remainingQuantity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  returnRate: number;
  returnRatePercent: number;
  fundingFee?: number;
}

export function calculatePositionPnl(params: {
  side: TradeSide | string;
  entryPrice: number;
  price: number;
  quantity: number;
  fee?: number;
}): number;

export function calculateTradePnl(
  trade: Partial<NormalizedTrade> &
    Pick<NormalizedTrade, "side" | "quantity" | "entryPrice">,
  currentPrice?: number | null,
): TradePnlResult;

export function parseTrades(
  input: string | unknown,
  format?: "auto" | "csv" | "json",
): NormalizedTrade[];
