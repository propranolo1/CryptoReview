import type { MarketCandle } from "./market.mjs";

export type TrainingInterval = "5m" | "15m" | "1h" | "4h";

export interface RandomTrainingRequest {
  symbol: "BTCUSDT";
  market: "binance-futures";
  interval: TrainingInterval;
  endTime: number;
  limit: number;
  url: string;
}

export interface TrainingContinuationRequest {
  symbol: "BTCUSDT";
  market: "binance-futures";
  interval: TrainingInterval;
  startTime: number;
  limit: number;
  url: string;
}

export type TrainingHistoryRequest = RandomTrainingRequest;

export interface PreparedTrainingCandles {
  source: string;
  symbol: "BTCUSDT";
  candles: MarketCandle[];
  initialCursor: number;
}

export function createRandomTrainingRequest(options?: {
  now?: number;
  random?: number;
  interval?: TrainingInterval;
  limit?: number;
  historyCandles?: number;
}): RandomTrainingRequest;

export function createTrainingHistoryRequest(options: {
  interval?: TrainingInterval;
  endTime: number;
  limit?: number;
}): TrainingHistoryRequest;

export function mergeTrainingHistoryPages(pages: unknown[]): {
  source: string;
  symbol: "BTCUSDT";
  candles: MarketCandle[];
};

export function createTrainingContinuationRequest(options: {
  interval?: TrainingInterval;
  startTime: number;
  limit?: number;
}): TrainingContinuationRequest;

export function prepareTrainingCandles(
  payload: unknown,
  options?: { contextCandles?: number; trainingCandles?: number },
): PreparedTrainingCandles;

export function prepareTrainingContinuationCandles(
  payload: unknown,
  options: { afterCloseTime: number },
): Omit<PreparedTrainingCandles, "initialCursor">;
