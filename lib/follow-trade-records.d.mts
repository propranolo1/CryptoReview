import type { BinanceUsdmOrder } from "./binance-orders.mjs";

export type FollowTradeAction = "openLong" | "closeLong" | "openShort" | "closeShort";

export interface FollowTradeEvent {
  id: string;
  time: string;
  action: FollowTradeAction;
  symbol: string;
  price: number;
  quantity: number;
  quoteQuantity: number;
  realizedPnl: number | null;
}

export function parseFollowTradeTimelineText(input: string): FollowTradeEvent[];
export function createFollowTradeOrderRecords(
  events: readonly FollowTradeEvent[],
  profile: { profileId: string; profileName: string },
): BinanceUsdmOrder[];
