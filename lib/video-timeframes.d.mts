export interface VideoTimeframeCandleInput {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume?: number;
  closeTime?: number;
}

export interface VideoTimeframeCandle extends VideoTimeframeCandleInput {
  closeTime: number;
}

export interface ReplayTimeframeOptions {
  cursor: number;
  replayTimeMs: number;
  currentCandle?: VideoTimeframeCandleInput;
}

export interface FixedReplayContextOptions {
  cursor: number;
  replayTimeMs?: number;
  currentCandle?: VideoTimeframeCandleInput;
  visibleCandles?: number;
}

export interface FixedReplayContext {
  candles: VideoTimeframeCandle[];
  startIndex: number;
  endIndex: number;
  slotCount: number;
  paddingSlots: number;
  currentSlot: number;
}

export const VIDEO_REPLAY_CONTEXT_DEFAULTS: Readonly<{
  visibleCandles: number;
}>;

export function buildReplayTimeframeCandles(
  candles: readonly VideoTimeframeCandleInput[],
  options: ReplayTimeframeOptions,
): {
  "15m": VideoTimeframeCandle[];
  "1H": VideoTimeframeCandle[];
  "4H": VideoTimeframeCandle[];
  "1D": VideoTimeframeCandle[];
};

export interface ReplayTimeframeAggregator {
  build(options: ReplayTimeframeOptions): Readonly<{
    "15m": readonly Readonly<VideoTimeframeCandle>[];
    "1H": readonly Readonly<VideoTimeframeCandle>[];
    "4H": readonly Readonly<VideoTimeframeCandle>[];
    "1D": readonly Readonly<VideoTimeframeCandle>[];
  }>;
}

export function createReplayTimeframeAggregator(
  candles: readonly VideoTimeframeCandleInput[],
  options?: {
    maxCandlesPerTimeframe?: number;
  },
): ReplayTimeframeAggregator;

export function buildFixedReplayContext(
  candles: readonly VideoTimeframeCandleInput[],
  options: FixedReplayContextOptions,
): FixedReplayContext;
