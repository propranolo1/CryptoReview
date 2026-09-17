export interface HistoryCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
  takerBuyVolume?: number;
}
export interface ReplayHistoryLoader {
  cancel(): void;
  load(candles: HistoryCandle[], visibleBars?: number): Promise<{
    candles: HistoryCandle[];
    addedCount: number;
    exhausted: boolean;
  } | null>;
}
export function createReplayHistoryLoader(options: {
  symbol: string;
  interval: string;
  market: string;
  fetchImpl: typeof fetch;
}): ReplayHistoryLoader;
export function shiftReplayHistoryRange(
  range: { from: number; to: number } | null,
  addedCount: number,
): { from: number; to: number } | null;
