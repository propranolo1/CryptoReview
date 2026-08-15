export interface PerformanceTradeExit {
  quantity: number | string;
  exitPrice?: number | string;
  price?: number | string;
  exitTime?: string | number | Date | null;
  fee?: number | string;
}

export interface PerformanceTrade {
  id: string;
  side: string;
  quantity: number | string;
  entryPrice: number | string;
  fee?: number | string;
  exits?: PerformanceTradeExit[];
  exitPrice?: number | string | null;
  exitTime?: string | number | Date | null;
  exitQuantity?: number | string | null;
  exitFee?: number | string;
  feesKnown?: boolean;
}

export interface TradeCloseGroup<T extends PerformanceTrade = PerformanceTrade> {
  date: string;
  trades: T[];
  count: number;
}

export interface TradePerformancePoint {
  tradeId: string;
  date: string;
  time: number;
  pnl: number;
  cumulativePnl: number;
}

export interface DailyTradePerformance {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface DailyPerformanceCalendarDay extends DailyTradePerformance {
  day: number;
  hasTrades: boolean;
  inRange: boolean;
}

export interface DailyPerformanceCalendarMonth {
  key: string;
  label: string;
  weeks: Array<Array<DailyPerformanceCalendarDay | null>>;
}

export interface TradePerformanceResult {
  points: TradePerformancePoint[];
  daily: DailyTradePerformance[];
  totalPnl: number;
  totalFees: number;
  knownFeeTrades: number;
  unknownFeeTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitLossRatio: number | null;
}

export function getTradeCloseTime(
  trade: Partial<PerformanceTrade> | null | undefined,
): number | null;

export function getTradeCloseDateKey(
  trade: Partial<PerformanceTrade> | null | undefined,
): string | null;

export function filterTradesByCloseDate<T extends PerformanceTrade>(
  trades: readonly T[],
  dateKey: string | null,
): T[];

export function groupTradesByCloseDate<T extends PerformanceTrade>(
  trades: readonly T[],
): TradeCloseGroup<T>[];

export function calculateTradePerformance<T extends PerformanceTrade>(
  trades: readonly T[],
): TradePerformanceResult;

export function buildDailyPerformanceCalendar(
  daily: readonly DailyTradePerformance[],
): DailyPerformanceCalendarMonth[];
