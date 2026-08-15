import type { MarketOpenInterestPoint } from "./market.mjs";

export interface VideoOpenInterestOptions {
  symbol: string;
  period: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";
  startTime: number;
  endTime: number;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface VideoOpenInterestResult {
  source: string | null;
  symbol: string;
  period: VideoOpenInterestOptions["period"];
  pagesFetched: number;
  points: MarketOpenInterestPoint[];
}

export type VideoOpenInterestFetcher = (
  input: string,
  init: {
    method: "GET";
    headers: { Accept: "application/json" };
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}>;

export const VIDEO_OPEN_INTEREST_PAGE_LIMIT: 500;
export const VIDEO_OPEN_INTEREST_MAX_PAGES: 64;

export function createVideoOpenInterestRequestUrl(
  options: VideoOpenInterestOptions,
): string;

export function fetchVideoOpenInterest(
  options: VideoOpenInterestOptions,
  fetcher?: VideoOpenInterestFetcher,
): Promise<VideoOpenInterestResult>;
