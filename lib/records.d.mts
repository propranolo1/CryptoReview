import type { NormalizedTrade } from "./trade.mjs";
import type { ReplayRiskLevel } from "./risk.mjs";

export interface ScreenshotReplayTrade extends NormalizedTrade {
  id: string;
  title: string;
  strategy: string;
  notes: string;
  riskLevels: ReplayRiskLevel[];
  orderIds: {
    entry: string;
    takeProfit: string;
    exit: string;
  };
  exitLabel: string;
  marketDataSource: "binance-futures";
  reportedRealizedPnl: number;
}

export function createHypeScreenshotTrade(): ScreenshotReplayTrade;
