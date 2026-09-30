import type { ISeriesPrimitive, Time } from "lightweight-charts";
import type { ReplayTradeMarker } from "./replay-markers.mjs";
export function drawReplayMarkerRing(context: CanvasRenderingContext2D, x: number, y: number, ratio: number, color: string, radius?: number): void;
export function createReplayMarkerRings(): ISeriesPrimitive<Time> & {
  setMarkers(markers: (ReplayTradeMarker & { anchorPrice: number })[]): void;
};
