export type TrainingSeriesUpdateMode =
  | "reset"
  | "append"
  | "update-last"
  | "none";

export interface TrainingSeriesCursor {
  readonly seriesKey: string;
  readonly length: number;
  readonly lastSignature: string;
}

export function createTrainingSeriesCursor(
  seriesKey: string,
  candles: readonly unknown[],
): TrainingSeriesCursor;

export function classifyTrainingSeriesUpdate(
  previous: TrainingSeriesCursor | null,
  seriesKey: string,
  candles: readonly unknown[],
): {
  mode: TrainingSeriesUpdateMode;
  cursor: TrainingSeriesCursor;
};
