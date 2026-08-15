export function calculateEmaSeries(
  prices: number[],
  period: number,
): Array<number | null>;

export function buildReplayEmaSeries(
  candles: Array<{ time: number; close: number }>,
  cursor: number,
  currentClose: number,
  period: number,
): Array<{ time: number; value: number }>;

export interface VolumeColoringConfig {
  rvolPeriod: number;
  lookback: number;
  highRvolMultiplier: number;
  lowRvolMultiplier: number;
}

export type VolumeCandleTone = "bullish" | "bearish" | "low";
export type VolumeCandleTrigger =
  | "rvol-high"
  | "rvol-low"
  | "lookback-high"
  | "lookback-low";

export interface VolumeCandleColorPoint {
  time: number;
  rvol: number | null;
  tone: VolumeCandleTone | null;
  trigger: VolumeCandleTrigger | null;
}

export const DEFAULT_VOLUME_COLORING_CONFIG: Readonly<VolumeColoringConfig>;

export function buildVolumeCandleColorSeries(
  candles: Array<{
    time: number;
    open: number;
    close: number;
    volume: number;
  }>,
  options?: Partial<Pick<VolumeColoringConfig, "rvolPeriod" | "lookback">>,
): {
  config: VolumeColoringConfig;
  points: VolumeCandleColorPoint[];
};

export function buildVolumeCandleColorPoint(
  candles: ReadonlyArray<{
    time: number;
    open: number;
    close: number;
    volume: number;
  }>,
  index: number,
  options?: Partial<Pick<VolumeColoringConfig, "rvolPeriod" | "lookback">>,
): VolumeCandleColorPoint;

export function calculateVolumeDelta(
  volume: number,
  takerBuyVolume: number,
): number;

export interface ReplayOrderFlowSeries {
  available: boolean;
  delta: Array<{ time: number; value: number }>;
  cvd: Array<{ time: number; value: number }>;
}

export function buildReplayOrderFlowSeries(
  candles: Array<{
    time: number;
    volume: number;
    takerBuyVolume?: number;
  }>,
  cursor: number,
  candlePhase: number,
): ReplayOrderFlowSeries;

export type XinMentorshipStatus =
  | "unavailable"
  | "extreme-overbought"
  | "overbought"
  | "extreme-oversold"
  | "oversold"
  | "bullish"
  | "bearish";

export type XinMentorshipSignal =
  | "gold-buy"
  | "strong-buy"
  | "buy"
  | "strong-sell"
  | "sell";

export interface XinMentorshipConfig {
  wtChannelLength: number;
  wtAverageLength: number;
  wtMaLength: number;
  overbought1: number;
  overbought2: number;
  oversold1: number;
  oversold2: number;
  rsiLength: number;
  mfiPeriod: number;
  mfiMultiplier: number;
  aoFast: number;
  aoSlow: number;
  momentumLookback: number;
  volumeConfirmation: boolean;
  volumeMaLength: number;
}

export interface XinMentorshipPoint {
  time: number;
  wt1: number | null;
  wt2: number | null;
  mfi: number | null;
  momentum: number | null;
  momentumDelta: number | null;
  rsi: number | null;
  acceleration: number | null;
  signal: XinMentorshipSignal | null;
  preBearWarning: boolean;
  preBullWarning: boolean;
  bearishWeakness: boolean;
  bullishStrength: boolean;
  bearishDivergence: boolean;
  bullishDivergence: boolean;
  divergenceTime: number | null;
  divergenceValue: number | null;
}

export interface XinMentorshipResult {
  config: XinMentorshipConfig;
  points: XinMentorshipPoint[];
  status: XinMentorshipStatus;
  summary: {
    totalBuys: number;
    totalSells: number;
    buyWinRate: number;
    sellWinRate: number;
    averageBuyPercent: number;
    averageSellPercent: number;
  };
}

export interface XinMentorshipCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function calculateXinMentorship(
  candles: XinMentorshipCandle[],
  options?: Partial<XinMentorshipConfig>,
): XinMentorshipResult;

export interface XinMentorshipAccumulator {
  readonly config: XinMentorshipConfig;
  readonly length: number;
  append(candle: XinMentorshipCandle): XinMentorshipPoint;
  replaceLast(candle: XinMentorshipCandle): XinMentorshipPoint;
  snapshot(): XinMentorshipResult;
}

export function createXinMentorshipAccumulator(
  options?: Partial<XinMentorshipConfig>,
): XinMentorshipAccumulator;

export function buildReplayXinMentorshipSeries(
  candles: XinMentorshipCandle[],
  cursor: number,
  currentCandle?: XinMentorshipCandle,
  options?: Partial<XinMentorshipConfig>,
): XinMentorshipResult;
