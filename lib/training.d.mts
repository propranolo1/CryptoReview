export type TrainingSide = "long" | "short";
export type TrainingActionType = "open" | "add" | "reduce" | "close";
export type TrainingRiskTrigger = "takeProfit" | "stopLoss" | "limitOrder";
export type TrainingLimitSide = "buy" | "sell";
export type TrainingLimitIntent = "open" | "add" | "reduce" | "close";
export type TrainingLimitOrderChangeType = "place" | "cancel" | "trigger";
export type TrainingRiskChangeSource = "drag" | "input" | "unknown";
export type TrainingMarketTiming = "candle-close" | "intrabar-unknown";
export type TrainingTimeInput = string | number | Date;
export type TrainingNumberInput = string | number;

export interface TrainingPosition {
  side: TrainingSide;
  quantity: number;
  averagePrice: number;
  margin: number;
}

export interface TrainingRiskLevels {
  takeProfit: number | null;
  stopLoss: number | null;
  takeProfitTrigger?: "above" | "below";
  takeProfitRatio?: number;
  stopLossRatio?: number;
  updatedAt: string;
}

export interface TrainingLimitOrder {
  limitOrderId: string;
  side: TrainingLimitSide;
  price: number;
  ratio: number;
  intent: TrainingLimitIntent;
  positionSide: TrainingSide;
  createdAt: string;
  marketLocation?: TrainingMarketLocation;
}

export interface TrainingLimitOrderChangeRecord {
  limitOrderChangeId: string;
  sequence: number;
  operationSequence: number;
  type: TrainingLimitOrderChangeType;
  time: string;
  recordedAt: string;
  order: TrainingLimitOrder;
  marketLocation?: TrainingMarketLocation;
  reason?: string;
}

export interface TrainingMarketLocation {
  interval: "5m" | "15m" | "1h" | "4h";
  candleOpenTimeMs: number;
  candleCloseTimeMs: number;
  /** K 线在当前训练行情数组中的绝对索引。 */
  candleIndex: number;
  /** 相对本局训练起点的位置，0 表示开始训练时已经显示的最后一根。 */
  revealedOffset: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 自动 TP/SL 只能确认在柱内触发，不能伪造精确秒数。 */
  timing: TrainingMarketTiming;
}

export interface TrainingActionRecord {
  actionId: string;
  sequence: number;
  operationSequence: number;
  type: TrainingActionType;
  /** 兼容旧记录的现实操作时间。 */
  time: string;
  /** 用户执行这笔操作时的现实记录时间。 */
  recordedAt: string;
  side: TrainingSide;
  price: number;
  quantity: number;
  /** 开仓/加仓代表新增保证金，减仓/平仓代表释放保证金。 */
  margin: number;
  capitalRatio: number | null;
  positionRatio: number | null;
  realizedPnl: number;
  totalRealizedPnl: number;
  positionBefore: TrainingPosition | null;
  positionAfter: TrainingPosition | null;
  unrealizedPnlAfter: number;
  equityAfter: number;
  availableCapitalAfter: number;
  marketLocation?: TrainingMarketLocation;
  riskBefore?: TrainingRiskLevels | null;
  riskAfter?: TrainingRiskLevels | null;
  automatic?: true;
  trigger?: TrainingRiskTrigger;
  limitOrderId?: string;
}

export interface TrainingRiskChangeRecord {
  riskChangeId: string;
  sequence: number;
  operationSequence: number;
  /** 兼容风险更新时间顺序校验的现实操作时间。 */
  time: string;
  recordedAt: string;
  source: TrainingRiskChangeSource;
  changed: {
    takeProfit: boolean;
    stopLoss: boolean;
    takeProfitRatio?: boolean;
    stopLossRatio?: boolean;
  };
  marketLocation?: TrainingMarketLocation;
  before: TrainingRiskLevels | null;
  after: TrainingRiskLevels | null;
  position: TrainingPosition;
}

export interface TrainingSession {
  id: string;
  symbol: "BTCUSDT";
  startingCapital: number;
  leverage: number;
  startedAt: string;
  status: "active" | "finished";
  realizedPnl: number;
  unrealizedPnl: number;
  usedMargin: number;
  availableCapital: number;
  walletBalance: number;
  equity: number;
  markPrice: number | null;
  position: TrainingPosition | null;
  risk: TrainingRiskLevels | null;
  actions: TrainingActionRecord[];
  /** 旧训练结果可能没有该字段，运行时会兼容为空数组。 */
  riskChanges: TrainingRiskChangeRecord[];
  limitOrders: TrainingLimitOrder[];
  /** 旧训练结果可能没有该字段，运行时会兼容为空数组。 */
  limitOrderChanges: TrainingLimitOrderChangeRecord[];
}

export interface TrainingResult extends TrainingSession {
  status: "finished";
  endedAt: string;
  endingCapital: number;
  netPnl: number;
  /** 小数收益率，例如 0.05 表示 5%。 */
  returnRate: number;
  returnRatePercent: number;
}

export interface TrainingAccountSnapshot {
  markPrice: number | null;
  walletBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  usedMargin: number;
  availableCapital: number;
}

interface TrainingActionBase {
  price: TrainingNumberInput;
  time: TrainingTimeInput;
  recordedAt?: TrainingTimeInput;
  marketLocation?: TrainingMarketLocation;
  automatic?: boolean;
  trigger?: TrainingRiskTrigger;
  limitOrderId?: string;
}

type TrainingEntrySize =
  | { margin: TrainingNumberInput; quantity?: never; capitalRatio?: never }
  | { margin?: never; quantity: TrainingNumberInput; capitalRatio?: never }
  | { margin?: never; quantity?: never; capitalRatio: TrainingNumberInput };

type TrainingReductionSize =
  | { quantity: TrainingNumberInput; positionRatio?: never }
  | { quantity?: never; positionRatio: TrainingNumberInput };

export type TrainingOpenAction = TrainingActionBase &
  TrainingEntrySize & {
    type: "open";
    side: TrainingSide;
  };

export type TrainingAddAction = TrainingActionBase &
  TrainingEntrySize & {
    type: "add";
  };

export type TrainingReduceAction = TrainingActionBase &
  TrainingReductionSize & {
    type: "reduce";
  };

export type TrainingCloseAction = TrainingActionBase & {
  type: "close";
  automatic?: boolean;
  trigger?: TrainingRiskTrigger;
};

export type TrainingAction =
  | TrainingOpenAction
  | TrainingAddAction
  | TrainingReduceAction
  | TrainingCloseAction;

export interface TrainingPerformancePoint {
  sessionId: string;
  date: string;
  time: number;
  pnl: number;
  cumulativePnl: number;
}

export interface DailyTrainingPerformance {
  date: string;
  pnl: number;
  sessions: number;
  wins: number;
  losses: number;
}

export interface TrainingPerformanceResult {
  totalSessions: number;
  totalPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  averageProfitLossRatio: number | null;
  cumulativeCurve: TrainingPerformancePoint[];
  daily: DailyTrainingPerformance[];
}

export function createTrainingSession(options: {
  id: string;
  symbol?: "BTCUSDT" | string;
  startingCapital?: TrainingNumberInput;
  leverage?: TrainingNumberInput;
  startedAt: TrainingTimeInput;
}): TrainingSession;

export function canStartNewTrainingRound(
  session: TrainingSession | TrainingResult | null | undefined,
): boolean;

export function getTrainingAccountSnapshot(
  session: TrainingSession,
  currentPrice?: TrainingNumberInput,
): TrainingAccountSnapshot;

export function setTrainingRiskLevels(
  session: TrainingSession,
  options: {
    takeProfit?: TrainingNumberInput | null;
    stopLoss?: TrainingNumberInput | null;
    takeProfitRatio?: TrainingNumberInput;
    stopLossRatio?: TrainingNumberInput;
    currentPrice?: TrainingNumberInput;
    time: TrainingTimeInput;
    recordedAt?: TrainingTimeInput;
    source?: TrainingRiskChangeSource;
    marketLocation?: TrainingMarketLocation;
  },
): TrainingSession;

export interface TrainingCandleInput {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  closeTime?: number;
}

export interface TrainingCandleTrigger {
  kind: TrainingRiskTrigger;
  price: number;
  time: string;
  candleTime: number;
  side: TrainingSide;
  positionRatio?: number;
  fullyClosed?: boolean;
}

export interface TrainingLimitOrderTrigger {
  limitOrderId: string;
  side: TrainingLimitSide;
  price: number;
  limitPrice: number;
  ratio: number;
  intent: TrainingLimitIntent;
  time: string;
  candleTime: number;
  actionId?: string;
}

export function processTrainingCandle(
  session: TrainingSession,
  candle: TrainingCandleInput,
  options: {
    time: TrainingTimeInput;
    marketLocation?: TrainingMarketLocation;
  },
): {
  session: TrainingSession;
  trigger: TrainingCandleTrigger | null;
  limitTriggers: TrainingLimitOrderTrigger[];
};

export function placeTrainingLimitOrder(
  session: TrainingSession,
  options: {
    side: TrainingLimitSide;
    price: TrainingNumberInput;
    currentPrice: TrainingNumberInput;
    ratio: TrainingNumberInput;
    time: TrainingTimeInput;
    recordedAt?: TrainingTimeInput;
    marketLocation?: TrainingMarketLocation;
  },
): TrainingSession;

export function cancelTrainingLimitOrder(
  session: TrainingSession,
  options: {
    limitOrderId: string;
    time: TrainingTimeInput;
    recordedAt?: TrainingTimeInput;
    marketLocation?: TrainingMarketLocation;
    reason?: string;
  },
): TrainingSession;

export function applyTrainingAction(
  session: TrainingSession,
  action: TrainingAction,
): TrainingSession;

export function finishTrainingSession(
  session: TrainingSession,
  options: {
    endedAt: TrainingTimeInput;
    exitPrice?: TrainingNumberInput;
  },
): TrainingResult;

export function hasTrainingTradeActivity(result: unknown): boolean;

export function calculateTrainingPerformance(
  results: readonly TrainingResult[],
): TrainingPerformanceResult;
