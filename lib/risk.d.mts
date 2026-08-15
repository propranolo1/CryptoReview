export type ReplayRiskKind = "takeProfit" | "stopLoss";
export type ReplayRiskEndState = "expired" | "cancelled" | "filled";
export type ReplayRiskState = "pending" | "active" | ReplayRiskEndState | "ended";
export type ReplayRiskExecutionType = "market" | "limit";
export type ReplayRiskSource = "ocr";
export type ReplayRiskOcrStatus = ReplayRiskEndState | "unknown";
export type ReplayRiskComparator = "<=" | ">=";
export type ReplayPriceLineLabel =
  | "成本"
  | "TP"
  | "SL"
  | "TP · MARKET"
  | "TP · LIMIT"
  | "SL · MARKET"
  | "SL · LIMIT";

export interface ReplayRiskLevel {
  id: string;
  orderId?: string;
  kind: ReplayRiskKind;
  inferred?: boolean;
  price: number;
  startTime: string;
  endTime: string | null;
  endState?: ReplayRiskEndState;
  executionType?: ReplayRiskExecutionType;
  source?: ReplayRiskSource;
  ocrStatus?: ReplayRiskOcrStatus;
  comparator?: ReplayRiskComparator;
  quantity?: number;
  asset?: string;
  confidence?: number;
  rawText?: string;
}

export interface ReplayPriceLine {
  id: string;
  kind: "cost" | ReplayRiskKind;
  price: number;
  label: ReplayPriceLineLabel;
  inferred?: boolean;
}

export interface ReplayRiskTrade {
  entryPrice: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
  riskLevels?: ReplayRiskLevel[];
}

export function getReplayPriceLines(
  trade: ReplayRiskTrade,
  replayTimeMs: number,
): ReplayPriceLine[];

export function getRiskLevelReplayState(
  level: ReplayRiskLevel,
  replayTimeMs: number,
): ReplayRiskState;
