import type {
  TrainingActionRecord,
  TrainingPosition,
  TrainingRiskChangeRecord,
  TrainingRiskLevels,
} from "./training.mjs";

export type TrainingAnalyticsTimeframe = "15m" | "1H" | "4H" | "1D";

export interface TrainingRiskExpectationItem {
  price: number;
  positionRatio: number;
  quantity: number;
  pnl: number;
  returnRatePercent: number;
  distancePercent: number;
}

export interface TrainingRiskExpectation {
  takeProfit: TrainingRiskExpectationItem | null;
  stopLoss: TrainingRiskExpectationItem | null;
  rewardRiskRatio: number | null;
}

export interface TrainingSessionSummary {
  version: 1;
  netPnl: number;
  returnRatePercent: number;
  initialRisk: number | null;
  rMultiple: number | null;
  mfe: number;
  mae: number;
  averageHoldingBars: number;
  averageHoldingMs: number;
  holdingCycleCount: number;
  addCount: number;
  reduceCount: number;
  direction: "long" | "short" | "mixed" | null;
  mainTimeframe: TrainingAnalyticsTimeframe;
  excursionBasis: "candle-high-low";
}

export interface TrainingAnalyticsGroup {
  sessions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  averageR: number | null;
}

export interface TrainingAnalyticsPerformance {
  averageR: number | null;
  rSampleSize: number;
  maxDrawdown: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  averageHoldingMs: number | null;
  averageMae: number | null;
  directionStats: {
    long: TrainingAnalyticsGroup;
    short: TrainingAnalyticsGroup;
  };
  timeframeStats: Record<TrainingAnalyticsTimeframe, TrainingAnalyticsGroup>;
}

export function calculateTrainingRiskExpectation(input: {
  startingCapital: number;
  position: TrainingPosition | null;
  risk: TrainingRiskLevels | null;
}): TrainingRiskExpectation;

export function buildTrainingSessionSummary(input: {
  result: {
    netPnl: number;
    returnRatePercent: number;
    actions: readonly TrainingActionRecord[];
    riskChanges?: readonly TrainingRiskChangeRecord[];
  };
  candles: readonly {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    closeTime?: number;
  }[];
  mainTimeframe: TrainingAnalyticsTimeframe;
}): TrainingSessionSummary;

export function calculateTrainingAnalyticsPerformance(
  results: readonly {
    id: string;
    endedAt: string;
    netPnl: number;
    actions?: readonly TrainingActionRecord[];
    summary?: TrainingSessionSummary;
  }[],
): TrainingAnalyticsPerformance;
