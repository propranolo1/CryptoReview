import type { BinanceUsdmOrder } from "./binance-orders.mjs";

export type BasicPositionAction =
  | "openLong"
  | "closeLong"
  | "openShort"
  | "closeShort";

export interface BasicOrderDraftInput {
  symbol: string;
  createdAt: string;
  orderType: "MARKET" | "LIMIT" | string;
  positionAction: BasicPositionAction | string;
  averagePrice: number | null;
  limitPrice: number | null;
  executedQuantity: number;
  originalQuantity: number;
  reduceOnly?: boolean | null;
  postOnly?: boolean | null;
  triggerConditionRaw?: string | null;
  status: string;
  triggeredByCondition?: boolean;
  confidence?: number;
  rawText?: string;
}

export interface ParsedBasicOrder extends BinanceUsdmOrder {
  source: "ocr-basic";
  positionAction: BasicPositionAction;
  reduceOnly: boolean;
  postOnly: boolean | null;
  triggeredByCondition: boolean;
  triggerConditionRaw: string | null;
  executionTimeKnown: false;
  confidence: number;
  rawText: string;
}

export interface BasicOcrWord {
  text?: unknown;
  confidence?: unknown;
  bbox?: { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
  boundingBox?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
}

export function parseBasicOrdersFromOcrWords(
  words: BasicOcrWord[],
  imageWidth: number,
): ParsedBasicOrder[];

export function createBasicOrderRecord(
  input: BasicOrderDraftInput,
): ParsedBasicOrder;

export function reconcileBasicOrdersWithArchive(
  currentOrders: unknown,
  incomingOrders: ParsedBasicOrder[],
): {
  newOrders: ParsedBasicOrder[];
  matchedExistingCount: number;
};
