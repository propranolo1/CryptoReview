import type { MarketCandle } from "./market.mjs";

export interface VideoMarketResult {
  source: string;
  symbol: string;
  interval: string;
  candles: MarketCandle[];
}

export function fetchVideoExportCandles(options: {
  fetchImpl: typeof fetch;
  symbol: string;
  interval: string;
  market: "binance" | "binance-futures";
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  endpoint?: string;
  maxPages?: number;
}): Promise<VideoMarketResult>;
