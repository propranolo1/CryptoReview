export type TrainingDrawingTimeframe = "15m" | "1H" | "4H" | "1D";

export function getTrainingDrawingBucketRange(input: {
  startTime: number;
  endTime: number;
  timeframe: TrainingDrawingTimeframe;
}): {
  startTime: number;
  endTime: number;
  intervalSeconds: number;
};

export function getTrainingDrawingTimeAtLogicalIndex(input: {
  candles: readonly { time: number }[];
  logicalIndex: number;
  timeframe: TrainingDrawingTimeframe;
}): number;

export function getTrainingDrawingLogicalIndex(input: {
  candles: readonly { time: number }[];
  time: number;
  timeframe: TrainingDrawingTimeframe;
}): number;

export type TrainingRectangleCorner =
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

export type TrainingRectangleCoordinates = {
  startTime: number;
  endTime: number;
  topPrice: number;
  bottomPrice: number;
};

export function moveTrainingRectangle<T extends TrainingRectangleCoordinates>(
  rectangle: T,
  offset: { timeDelta: number; priceDelta: number },
): T;

export function resizeTrainingRectangle<T extends TrainingRectangleCoordinates>(
  rectangle: T,
  corner: TrainingRectangleCorner,
  point: { time: number; price: number },
): T;
