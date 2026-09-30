export interface ReplayTradeMarker {
  time: number;
  index: number;
  side: "buy" | "sell";
  count: number;
  text: string;
  price: number;
  quantity: number;
  ratio: number | null;
}
export function buildReplayTradeMarkers(
  candles: readonly { time: number; closeTime?: number }[],
  events: readonly { timeMs: number; side: "buy" | "sell"; price: number; quantity: number }[],
  replayTimeMs: number,
  options?: { peakQuantity: number; showRatio?: boolean },
): ReplayTradeMarker[];
