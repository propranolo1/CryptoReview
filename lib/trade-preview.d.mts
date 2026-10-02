import type { NormalizedTrade } from "./trade.mjs";
import type { MarketCandle } from "./market.mjs";
import type { ReplayTradeEvent } from "./replay.mjs";

export type PreviewTrade = NormalizedTrade & { id: string; marketDataSource?: "binance-futures"; openPosition?: object; syncSources?: string[] };
export interface PreviewPlan {
  symbol: string; market: string; interval: string; intervalMs: number; startTime: number; requestStartTime: number; endTime: number;
  entryTime: number; tradeEndTime: number; holdingMs: number; paddingMs: number; limit: number; open: boolean; events: ReplayTradeEvent[];
}
export interface PreviewMarker {
  side: "buy" | "sell"; price: number; timeMs: number; quantity: number; events: ReplayTradeEvent[];
  x: number; y: number; labelY: number;
}
export interface PreviewPlot { path: string; markers: PreviewMarker[]; minimum: number; maximum: number; entryX: number; endX: number; notice: string }
export interface PreviewState {
  trade: PreviewTrade; position: { left: number; top: number }; status: "loading" | "ready" | "error";
  message?: string; plan?: PreviewPlan; plot?: PreviewPlot; source?: string;
}
export interface PreviewController {
  enter(trade: PreviewTrade, bounds: { left: number; right: number; top: number }, viewport: { width: number; height: number }): void;
  leave(): void; retain(): void; close(): void; dispose(): void;
}
export function buildTradePreviewPlan(trade: PreviewTrade, now?: number): PreviewPlan;
export function buildTradePreviewPlot(candles: MarketCandle[], plan: PreviewPlan): PreviewPlot;
export function getTradePreviewPosition(bounds: { left: number; right: number; top: number }, viewport: { width: number; height: number }): { left: number; top: number };
export function createTradePreviewController(options: { fetchImpl: typeof fetch; onChange(state: PreviewState | null): void; now?: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }): PreviewController;
