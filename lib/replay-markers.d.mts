export interface ReplayTradeMarker {
  time: number;
  index: number;
  side: "buy" | "sell";
  count: number;
  text: string;
  price: number;
}
export function buildReplayTradeMarkers(
  candles: readonly { time: number; closeTime?: number }[],
  events: readonly { timeMs: number; side: "buy" | "sell"; price: number }[],
  replayTimeMs: number,
): ReplayTradeMarker[];
