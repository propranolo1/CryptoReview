export interface TrainingResultArchiveRecord {
  id: string;
  symbol: "BTCUSDT";
  status: "finished";
  startingCapital: number;
  netPnl: number;
  endedAt: string;
  recordedAt: string;
  interval: "5m" | "15m" | "1h" | "4h";
  source: string;
  windowStartTime: number;
  windowEndTime: number;
  barsViewed: number;
  mainTimeframe?: "15m" | "1H" | "4H" | "1D";
  summary?: {
    version: 1;
    netPnl: number;
    returnRatePercent: number;
    initialRisk: number | null;
    rMultiple: number | null;
    mfe: number;
    mae: number;
    averageHoldingBars: number;
    averageHoldingMs: number;
    holdingCycleCount: number;
    addCount: number;
    reduceCount: number;
    direction: "long" | "short" | "mixed" | null;
    mainTimeframe: "15m" | "1H" | "4H" | "1D";
    excursionBasis: "candle-high-low";
  };
  actions: Record<string, unknown>[];
  riskChanges: Record<string, unknown>[];
  markers: Array<{
    id: string;
    actionId?: string;
    time: number;
    direction: "buy" | "sell";
    label: string;
    price: number;
  }>;
  [key: string]: unknown;
}

export function serializeTrainingResultsExport(
  results: readonly unknown[],
  options?: { exportedAt?: string | number | Date },
): string;

export function parseTrainingResultsImport(
  input: string,
): TrainingResultArchiveRecord[];

export function mergeTrainingResultRecords(
  ...collections: unknown[][]
): TrainingResultArchiveRecord[];
