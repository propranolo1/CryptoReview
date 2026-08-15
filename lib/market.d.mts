export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume?: number;
  closeTime: number;
}

export interface MarketOpenInterestPoint {
  time: number;
  openInterest: number;
  openInterestValue: number;
}

export function createBinanceFuturesKlineUrl(options: {
  symbol: string;
  interval: string;
  startTime?: number | null;
  endTime?: number | null;
  limit: number;
}): string;

export function createBinanceFuturesOpenInterestUrl(options: {
  symbol: string;
  period: string;
  startTime?: number | null;
  endTime?: number | null;
  limit: number;
}): string;

export function parseBinanceKlines(payload: unknown): MarketCandle[];

export function parseBinanceOpenInterestHistory(payload: unknown): MarketOpenInterestPoint[];
