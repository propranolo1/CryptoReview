import type { ReplayRiskLevel } from "./risk.mjs";

export type ConditionalCloseSide = "closeLong" | "closeShort";
export type ConditionalOrderKind = "takeProfit" | "stopLoss";
export type ConditionalExecutionType = "market" | "limit";
export type ConditionalComparator = "<=" | ">=";
export type ConditionalOcrStatus =
  | "filled"
  | "cancelled"
  | "expired"
  | "unknown";

export interface TesseractOcrBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RectangleOcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConditionalOrderOcrWord {
  text: string;
  confidence?: number;
  bbox?: TesseractOcrBoundingBox;
  boundingBox?: RectangleOcrBoundingBox;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ParsedConditionalOrder {
  id: string;
  symbol: string;
  createdTime: string;
  closeSide: ConditionalCloseSide;
  kind: ConditionalOrderKind;
  executionType: ConditionalExecutionType;
  triggerPrice: number;
  comparator: ConditionalComparator;
  quantity: number;
  asset: string;
  status: ConditionalOcrStatus;
  confidence: number;
  rawText: string;
}

export interface ConditionalOcrRiskLevel extends ReplayRiskLevel {
  executionType: ConditionalExecutionType;
  source: "ocr";
  ocrStatus: ConditionalOcrStatus;
  comparator: ConditionalComparator;
  quantity: number;
  asset: string;
  confidence: number;
  rawText: string;
}

export interface ConditionalTradeExit {
  exitTime?: string | number | Date | null;
}

export interface AttachableConditionalTrade {
  symbol: string;
  side: string;
  entryTime: string | number | Date | null;
  exitTime?: string | number | Date | null;
  exits?: ConditionalTradeExit[];
  takeProfit?: number | null;
  stopLoss?: number | null;
  riskLevels?: ReplayRiskLevel[];
}

export function parseConditionOrdersFromOcrWords(
  words: readonly ConditionalOrderOcrWord[],
  imageWidth: number,
): ParsedConditionalOrder[];

export function attachConditionOrdersToTrades<T extends AttachableConditionalTrade>(
  trades: readonly T[],
  orders: readonly ParsedConditionalOrder[],
): T[];
