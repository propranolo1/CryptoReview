export interface OhlcCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReplayFrameState {
  cursor: number;
  phase: number;
}

export interface ReplayFrameResult extends ReplayFrameState {
  finished: boolean;
}

export interface ReplayPositionEntry {
  id?: string;
  sourceOrderId?: string | null;
  orderId?: string | null;
  quantity: number;
  entryPrice?: number | null;
  entryTime?: string | number | null;
  time?: string | number | null;
  fee?: number;
}

export interface ReplayPositionSegment {
  id: string;
  sourceOrderId: string | null;
  entryTime: string | null;
  entryPrice: number | null;
  initialQuantity: number;
  remainingQuantity: number;
  ratio: number;
  shareOfCurrent: number;
  colorIndex: number;
  isAddition: boolean;
}

export interface ReplayPositionState {
  hasEntered: boolean;
  isClosed: boolean;
  currentQuantity: number;
  peakQuantity: number;
  ratio: number;
  label: string;
  segments: ReplayPositionSegment[];
}

export interface ReplayVisibleEntry {
  id: string;
  sourceOrderId: string | null;
  quantity: number;
  entryPrice: number;
  entryTime: string | null;
  fee: number;
}

export interface ReplayVisibleExit extends TradeExit {
  id: string;
  sourceOrderId: string | null;
}

export interface ReplayFundingFee {
  transactionId: string;
  amount: number;
  asset?: string;
  time: string;
}

export interface ReplayTradeEvent {
  id: string;
  type: "entry" | "exit";
  side: "buy" | "sell";
  timeMs: number;
  price: number;
  quantity: number;
  isAddition: boolean;
  sourceOrderId: string | null;
}

export interface ReplayTradePnlResult extends TradePnlResult {
  entryFees: number;
  exitFees: number;
  totalFees: number;
}

export interface ReplayTradeSnapshot {
  hasEntered: boolean;
  isClosed: boolean;
  currentQuantity: number;
  peakQuantity: number;
  averageEntryPrice: number | null;
  accruedFees: number;
  accruedFundingFee?: number;
  visibleEntries: ReplayVisibleEntry[];
  visibleExits: ReplayVisibleExit[];
  visibleFundingFees?: ReplayFundingFee[];
  events: ReplayTradeEvent[];
  pnl: ReplayTradePnlResult | null;
}

export type ReplayProgressAction =
  | {
      type: "risk-created" | "risk-cancelled" | "risk-expired" | "risk-filled";
      riskKind: ReplayRiskKind;
      executionType?: ReplayRiskExecutionType;
      price: number;
      inferred: boolean;
    }
  | {
      type: "risk-modified";
      riskKind: ReplayRiskKind;
      executionType?: ReplayRiskExecutionType;
      previousPrice: number;
      price: number;
      inferred: boolean;
    }
  | {
      type: "partial-close" | "full-close";
      quantity: number;
      exitPrice: number;
    };

export interface ReplayProgressNode {
  id: string;
  timeMs: number;
  cursor: number;
  phase: number;
  positionPercent: number;
  tone: ReplayRiskKind | "modified" | "cancelled" | "expired" | "exit";
  actions: ReplayProgressAction[];
}

export function buildPartialCandle<T extends OhlcCandle>(
  candle: T,
  phase: number,
): T;

export function getReplayVolume(volume: number, phase: number): number;

export function getReplayOpenInterestPoints<T extends { time: number }>(
  points: T[],
  replayTimeMs: number,
): T[];

export function buildReplayMarketDataKey(
  trade: {
    id?: string;
    symbol?: string;
    marketDataSource?: string;
    entryTime?: string | number | null;
    side?: "long" | "short";
    entryPrice?: number;
    exits?: Array<{
      exitTime?: string | number | null;
      exitPrice?: number | null;
    }>;
  },
  frame: string,
): string;

export function getReplayTimeMs(
  candle: { time: number; closeTime?: number },
  phase: number,
  nextCandle?: { time: number },
): number;

export function getCandlePhaseAtTime(
  candle: { time: number; closeTime?: number },
  timeMs: number,
  nextCandle?: { time: number },
): number;

export function locateReplayFrameAtTime(
  candles: Array<{ time: number; closeTime?: number }>,
  timeMs: number,
  minimumCursor?: number,
): ReplayFrameState;

export function locateReplayCandleAtTime(
  candles: Array<{ time: number; closeTime?: number }>,
  timeMs: number,
  minimumCursor?: number,
  minimumPhase?: number,
): ReplayFrameState;

export function buildReplayProgressNodes(
  trade: {
    quantity: number;
    exits?: TradeExit[];
    riskLevels?: ReplayRiskLevel[];
  },
  candles: Array<{ time: number; closeTime?: number }>,
  entryIndex: number,
): ReplayProgressNode[];

export function buildReplayPositionState(
  trade: {
    quantity: number;
    entryPrice?: number;
    entryTime?: string | number | null;
    entries?: ReplayPositionEntry[];
    exits?: TradeExit[];
    exitPrice?: number | null;
    exitTime?: string | number | null;
  },
  replayTimeMs?: string | number | null,
): ReplayPositionState;

export function buildReplayTradeSnapshot(
  trade: {
    side: "long" | "short";
    quantity: number;
    entryPrice?: number;
    entryTime?: string | number | null;
    fee?: number;
    fundingFees?: ReplayFundingFee[];
    entries?: ReplayPositionEntry[];
    exits?: TradeExit[];
    exitPrice?: number | null;
    exitTime?: string | number | null;
  },
  replayTimeMs?: string | number | null,
  currentPrice?: number | null,
): ReplayTradeSnapshot;

export function formatPositionRatioLabel(ratio: number): string;

export function advanceReplayFrame(
  state: ReplayFrameState,
  candleCount: number,
  phaseStep: number,
): ReplayFrameResult;
import type { ReplayRiskExecutionType, ReplayRiskKind, ReplayRiskLevel } from "./risk.mjs";
import type { TradeExit, TradePnlResult } from "./trade.mjs";
