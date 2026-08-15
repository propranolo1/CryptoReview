"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChevronRight,
  CircleDot,
  FileUp,
  Gauge,
  GraduationCap,
  Moon,
  Pause,
  Play,
  UserPlus,
  Users,
  RotateCcw,
  ShieldAlert,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Target,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type {
  CandlestickData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import {
  calculateTradePnl,
  parseTrades,
  type NormalizedTrade,
  type TradePnlResult,
} from "@/lib/trade.mjs";
import {
  advanceReplayFrame,
  buildReplayMarketDataKey,
  buildPartialCandle,
  buildReplayPositionState,
  buildReplayProgressNodes,
  buildReplayTradeSnapshot,
  getCandlePhaseAtTime,
  getReplayOpenInterestPoints,
  getReplayTimeMs,
  getReplayVolume,
  locateReplayFrameAtTime,
  type ReplayProgressAction,
} from "@/lib/replay.mjs";
import {
  createSettlementTrade,
  mergeDefaultAndImportedTrades,
} from "@/lib/simulation.mjs";
import { createHypeScreenshotTrade } from "@/lib/records.mjs";
import {
  getReplayPriceLines,
  type ReplayRiskLevel,
} from "@/lib/risk.mjs";
import {
  isBinanceUsdmOrderHistoryCsv,
  mergeBinanceApiReplays,
  mergeBinanceOrderRecords,
  mergeImportedReplays,
  mergeOkxApiReplays,
  parseBinanceUsdmOrderHistoryCsv,
  reconstructBinanceUsdmReplays,
  type BinanceOpenPosition,
  type BinanceUsdmOrder,
  type ReplaySyncSource,
} from "@/lib/binance-orders.mjs";
import {
  createPublicLeadOpenPositions,
  createPublicLeadOrderRecords,
  createStoredPublicLeadSnapshot,
  diffPublicLeadSnapshots,
  normalizePublicLeadSnapshot,
  type CopyTradeMonitorConfig,
  type PublicLeadPositionChange,
} from "@/lib/copy-trade-monitor.mjs";
import { attachConditionOrdersToTrades } from "@/lib/conditional-orders.mjs";
import {
  buildReplayEmaSeries,
  buildReplayOrderFlowSeries,
  buildReplayXinMentorshipSeries,
  buildVolumeCandleColorSeries,
} from "@/lib/indicators.mjs";
import {
  reconcileBasicOrdersWithArchive,
  type ParsedBasicOrder,
} from "@/lib/basic-orders.mjs";
import {
  filterTradesByCloseDate,
  getTradeCloseTime,
  groupTradesByCloseDate,
} from "@/lib/performance.mjs";
import { persistDesktopReplaySnapshot } from "@/lib/replay-persistence.mjs";
import {
  DEFAULT_TRADE_PROFILE_ID,
  assignTradeProfile,
  createTradeProfile,
  filterRecordsByTradeProfile,
  normalizeTradeProfiles,
  type TradeProfile,
} from "@/lib/trade-profiles.mjs";
import {
  extractSmartMoneyProfileId,
  normalizeSmartMoneyProfileSnapshot,
  upsertSmartMoneyTradeProfile,
} from "@/lib/smart-money-profile.mjs";
import {
  createFollowTradeOrderRecords,
  type FollowTradeEvent,
} from "@/lib/follow-trade-records.mjs";
import { PerformanceOverview } from "./PerformanceOverview";
import { AppUpdateControl } from "./AppUpdateControl";
import {
  TrainingMode,
  type TrainingResultRecord,
} from "./TrainingMode";
import {
  ConditionOrderImport,
  type ConfirmedConditionOrder,
} from "./ConditionOrderImport";
import { BasicOrderImport } from "./BasicOrderImport";
import { BinanceApiConnect } from "./BinanceApiConnect";
import { ReplayVideoExport } from "./ReplayVideoExport";
import { FollowTradeImport } from "./FollowTradeImport";
import { LeadPortfolioMonitor } from "./LeadPortfolioMonitor";
import { SmartMoneyImport } from "./SmartMoneyImport";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume?: number;
  closeTime?: number;
};

type OpenInterestPoint = {
  time: number;
  openInterest: number;
  openInterestValue: number;
};

type OpenInterestStatus = "idle" | "loading" | "available" | "unavailable";

type ReplayTrade = NormalizedTrade & {
  id: string;
  title: string;
  strategy: string;
  notes: string;
  profileId?: string;
  profileName?: string;
  riskLevels?: ReplayRiskLevel[];
  exitLabel?: string;
  marketDataSource?: "binance-futures";
  feesKnown?: boolean;
  sourceKey?: string;
  sourceEntryOrderId?: string;
  sourceEntryAliases?: string[];
  sourceOrderIds?: string[];
  syncSources?: ReplaySyncSource[];
  reconstructionNotice?: string;
  reportedRealizedPnl?: number;
  commissionByAsset?: Record<string, number>;
  fundingFeesKnown?: boolean;
  fundingFees?: BinanceOpenPosition["fundingFees"];
  fundingFee?: number;
  openPosition?: Omit<BinanceOpenPosition, "syncedAt"> & {
    syncedAt: string | null;
  };
  orderIds?: {
    entry: string;
    takeProfit: string;
    exit: string;
  };
};

type BinanceOrderRecord = BinanceUsdmOrder;

function reconstructReplayableBinanceOrders(
  orders: BinanceOrderRecord[],
  options?: { openPositions?: BinanceOpenPosition[]; syncedAt?: string | number | null },
) {
  return reconstructBinanceUsdmReplays(orders, options);
}

type TimeFrame = "5m" | "15m" | "1h" | "4h" | "1d";

type PersistenceMode = "loading" | "browser" | "desktop";

type ActiveModule = "replay" | "performance" | "training";

type AppTheme = "light" | "dark";

type IndicatorVisibility = {
  xinMentorship: boolean;
  ema21: boolean;
  ema200: boolean;
  volumeColoring: boolean;
  volume: boolean;
  openInterest: boolean;
  delta: boolean;
  cvd: boolean;
};

type VolumeColoringConfig = {
  rvolPeriod: number;
  lookback: number;
};

const DEFAULT_INDICATOR_VISIBILITY: IndicatorVisibility = {
  xinMentorship: true,
  ema21: true,
  ema200: true,
  volumeColoring: true,
  volume: true,
  openInterest: true,
  delta: true,
  cvd: true,
};

const INDICATOR_OPTIONS: Array<{
  key: keyof IndicatorVisibility;
  label: string;
}> = [
  { key: "xinMentorship", label: "XIN Mentorship" },
  { key: "ema21", label: "EMA21" },
  { key: "ema200", label: "EMA200" },
  { key: "volumeColoring", label: "成交量染色" },
  { key: "volume", label: "成交量" },
  { key: "openInterest", label: "OI" },
  { key: "delta", label: "Delta" },
  { key: "cvd", label: "CVD" },
];

const XIN_STATUS_LABELS = {
  unavailable: "预热中",
  "extreme-overbought": "极度超买",
  overbought: "超买",
  "extreme-oversold": "极度超卖",
  oversold: "超卖",
  bullish: "偏多",
  bearish: "偏空",
} as const;

const FRAME_MS: Record<TimeFrame, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const FRAME_LABELS: Record<TimeFrame, string> = {
  "5m": "5分",
  "15m": "15分",
  "1h": "1时",
  "4h": "4时",
  "1d": "日线",
};

const EMA_WARMUP_CANDLES = 280;
const CHART_PRE_ENTRY_CANDLES = 80;
const DEFAULT_VOLUME_COLORING_CONFIG: VolumeColoringConfig = {
  rvolPeriod: 20,
  lookback: 30,
};
const VOLUME_COLORING_MAX_PERIOD = 250;
const VOLUME_CANDLE_COLORS = {
  bullish: "#00df3b",
  bearish: "#ff304f",
  low: "#ffd400",
} as const;

const TRADES_STORAGE_KEY = "cryptoreview-trades-v1";
const ORDER_HISTORY_STORAGE_KEY = "cryptoreview-binance-orders-v1";
const TRAINING_RESULTS_STORAGE_KEY = "cryptoreview-training-results-v1";
const TRADE_PROFILES_STORAGE_KEY = "cryptoreview-trade-profiles-v1";
const ACTIVE_TRADE_PROFILE_STORAGE_KEY = "cryptoreview-active-trade-profile-v1";

function mergeTrainingResults(...collections: unknown[][]): TrainingResultRecord[] {
  const byId = new Map<string, TrainingResultRecord>();
  for (const collection of collections) {
    for (const value of collection) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const result = value as Partial<TrainingResultRecord>;
      if (
        typeof result.id !== "string" ||
        result.id.trim() === "" ||
        result.status !== "finished" ||
        typeof result.netPnl !== "number" ||
        !Number.isFinite(result.netPnl) ||
        typeof result.endedAt !== "string" ||
        !Number.isFinite(Date.parse(result.endedAt))
      ) {
        continue;
      }
      const existing = byId.get(result.id);
      const resultTime = Date.parse(result.recordedAt ?? result.endedAt);
      const existingTime = existing
        ? Date.parse(existing.recordedAt ?? existing.endedAt)
        : Number.NEGATIVE_INFINITY;
      if (!existing || resultTime >= existingTime) {
        byId.set(result.id, result as TrainingResultRecord);
      }
    }
  }
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt),
  );
}

function replayPersistenceKey(trade: ReplayTrade) {
  const profilePrefix = `${trade.profileId ?? DEFAULT_TRADE_PROFILE_ID}:`;
  if (trade.sourceKey) return `${profilePrefix}source:${trade.sourceKey}`;
  if (trade.sourceEntryOrderId) {
    return `${profilePrefix}entry:${normalizeSymbol(trade.symbol)}:${trade.sourceEntryOrderId}`;
  }
  if (trade.orderIds?.entry) {
    return `${profilePrefix}entry:${normalizeSymbol(trade.symbol)}:${trade.orderIds.entry}`;
  }
  return `${profilePrefix}id:${trade.id}`;
}

function mergeDesktopAndBrowserTrades(
  browserTrades: ReplayTrade[],
  desktopTrades: unknown,
) {
  const restoredDesktopTrades = mergeDefaultAndImportedTrades(
    DEFAULT_TRADES,
    desktopTrades,
  );
  const desktopKeys = new Set(restoredDesktopTrades.map(replayPersistenceKey));
  const browserOnlyTrades = browserTrades.filter(
    (trade) => trade.id.startsWith("import-") && !desktopKeys.has(replayPersistenceKey(trade)),
  );
  return [...restoredDesktopTrades, ...browserOnlyTrades];
}

const DEFAULT_TRADES: ReplayTrade[] = [
  {
    ...createHypeScreenshotTrade(),
    syncSources: ["built-in"],
  },
  {
    ...createSettlementTrade({
      symbol: "BTCUSDT",
      side: "long",
      quantity: 0.2,
      candles: [
        { time: 1_784_044_800, open: 64_744, close: 64_730 },
        {
          time: 1_784_127_600,
          open: 65_399.8,
          close: 65_427.61,
          closeTime: 1_784_131_199_999,
        },
      ],
      stopLoss: 64_000,
      takeProfit: 66_000,
      entryFee: 6.5,
      exitFee: 6.6,
    }),
    id: "btc-breakout",
    title: "07-15 模拟交割",
    strategy: "24H 收盘交割",
    notes: "基于 2026-07-15（UTC+8）Binance 小时 K 线：首根开盘做多，最后一根收盘交割。",
    syncSources: ["simulation"],
  },
  {
    ...createSettlementTrade({
      symbol: "SOLUSDT",
      side: "short",
      quantity: 50,
      candles: [
        { time: 1_784_044_800, open: 77.39, close: 77.28 },
        {
          time: 1_784_127_600,
          open: 78.22,
          close: 78.07,
          closeTime: 1_784_131_199_999,
        },
      ],
      stopLoss: 79.2,
      takeProfit: 75,
      entryFee: 3.9,
      exitFee: 4,
    }),
    id: "sol-reversal",
    title: "07-15 模拟交割",
    strategy: "24H 收盘交割",
    notes: "基于 2026-07-15（UTC+8）Binance 小时 K 线：首根开空，最后一根收盘交割。",
    syncSources: ["simulation"],
  },
];

const EMPTY_PNL: TradePnlResult = {
  entryNotional: 0,
  exitedQuantity: 0,
  remainingQuantity: 0,
  realizedPnl: 0,
  unrealizedPnl: 0,
  totalPnl: 0,
  returnRate: 0,
  returnRatePercent: 0,
};

function normalizeSymbol(symbol: string) {
  return symbol.toUpperCase().replace(/[\s/_-]/g, "");
}

function displaySymbol(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  if (normalized.endsWith("USDT")) return `${normalized.slice(0, -4)}/USDT`;
  if (normalized.endsWith("USDC")) return `${normalized.slice(0, -4)}/USDC`;
  return normalized;
}

function formatPrice(value: number) {
  const digits = value >= 1_000 ? 2 : value >= 10 ? 3 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatMoney(value: number, showSign = false) {
  const absolute = Math.abs(value);
  const formatted = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(absolute);
  const sign = value < 0 ? "−" : showSign && value > 0 ? "+" : "";
  return `${sign}$${formatted}`;
}

function formatPercent(value: number, showSign = false) {
  const sign = value < 0 ? "−" : showSign && value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(isoOrMs: string | number | null | undefined) {
  if (!isoOrMs) return "时间未记录";
  const date = new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return "时间无效";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatPublicLeadPositionChanges(changes: PublicLeadPositionChange[]) {
  if (changes.length === 0) return "";
  const labels: Record<PublicLeadPositionChange["kind"], string> = {
    opened: "开仓",
    increased: "加仓",
    reduced: "减仓",
    closed: "平仓",
  };
  const summary = changes
    .slice(0, 4)
    .map((change) => `${change.symbol} ${labels[change.kind]}`)
    .join("、");
  const remaining = changes.length > 4 ? `等 ${changes.length} 项` : "";
  return `检测到仓位变化：${summary}${remaining}。`;
}

const REPLAY_SYNC_SOURCE_LABELS: Record<ReplaySyncSource, string> = {
  "okx-api": "OKX API",
  "binance-api": "Binance API",
  "copy-trade-public": "Binance 公开带单",
  "smart-money-public": "Binance 聪明钱",
  "binance-csv": "Binance CSV",
  "ocr-basic": "OCR 基础单",
  "ocr-follow": "OCR 跟单记录",
  "ocr-condition": "OCR 条件单",
  "manual-csv": "手动 CSV",
  "manual-json": "手动 JSON",
  "built-in": "内置记录",
  "simulation": "模拟交割",
  "legacy-import": "Binance 历史",
};

const REPLAY_SYNC_SOURCE_SHORT_LABELS: Record<ReplaySyncSource, string> = {
  "okx-api": "OKX",
  "binance-api": "API",
  "copy-trade-public": "公开带单",
  "smart-money-public": "聪明钱",
  "binance-csv": "CSV",
  "ocr-basic": "基础单 OCR",
  "ocr-follow": "跟单 OCR",
  "ocr-condition": "条件单 OCR",
  "manual-csv": "手动 CSV",
  "manual-json": "手动 JSON",
  "built-in": "内置记录",
  "simulation": "模拟",
  "legacy-import": "历史导入",
};

const REPLAY_SYNC_SOURCE_ORDER = Object.keys(
  REPLAY_SYNC_SOURCE_LABELS,
) as ReplaySyncSource[];

function getReplaySyncSources(trade: ReplayTrade) {
  const sources = new Set<ReplaySyncSource>();
  for (const source of trade.syncSources ?? []) {
    if (source in REPLAY_SYNC_SOURCE_LABELS) sources.add(source);
  }
  if (trade.riskLevels?.some((level) => level.source === "ocr")) {
    sources.add("ocr-condition");
  }

  const hasExecutionSource = [...sources].some((source) => source !== "ocr-condition");
  if (!hasExecutionSource) {
    if (trade.id === "btc-breakout" || trade.id === "sol-reversal") {
      sources.add("simulation");
    } else if (trade.id === "hype-screenshot-review") {
      sources.add("built-in");
    } else if (trade.sourceEntryOrderId || trade.sourceKey) {
      sources.add("legacy-import");
    } else if (trade.id.startsWith("import-")) {
      sources.add("legacy-import");
    } else {
      sources.add("built-in");
    }
  }

  return REPLAY_SYNC_SOURCE_ORDER.filter((source) => sources.has(source));
}

function getReplaySourceDisplay(trade: ReplayTrade) {
  const sources = getReplaySyncSources(trade);
  const executionSources = sources.filter((source) => source !== "ocr-condition");
  const primarySource = executionSources[0] ?? "legacy-import";
  const extraSourceCount = Math.max(executionSources.length - 1, 0);
  const details = [
    `成交来源：${executionSources.map((source) => REPLAY_SYNC_SOURCE_LABELS[source]).join("、")}`,
  ];
  if (sources.includes("ocr-condition")) {
    details.push("条件单补充：OCR 条件单");
  }
  if (sources.includes("okx-api")) {
    details.push("订单来源 OKX，行情来源 Binance U 本位公共行情");
  }
  return {
    shortLabel: `${REPLAY_SYNC_SOURCE_SHORT_LABELS[primarySource]}${extraSourceCount > 0 ? ` +${extraSourceCount}` : ""}`,
    title: details.join("；"),
  };
}

function formatReplayEventTime(timeMs: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timeMs));
}

function formatReplayProgressAction(action: ReplayProgressAction) {
  if ("exitPrice" in action) {
    const closeLabel = action.type === "full-close" ? "全部平仓" : "部分平仓";
    return `${closeLabel} ${formatCompactNumber(action.quantity)} @ ${formatPrice(action.exitPrice)}`;
  }

  const riskLabel = action.riskKind === "takeProfit" ? "TP" : "SL";
  const executionLabel = action.executionType ? ` · ${action.executionType.toUpperCase()}` : "";
  const inferredLabel = action.inferred ? "（时间推定）" : "";
  if (action.type === "risk-modified") {
    return `修改 ${riskLabel}${executionLabel}：${formatPrice(action.previousPrice)} → ${formatPrice(action.price)}${inferredLabel}`;
  }
  const actionLabels = {
    "risk-created": "设置",
    "risk-cancelled": "撤销",
    "risk-expired": "过期",
    "risk-filled": "触发成交",
  } as const;
  return `${actionLabels[action.type]} ${riskLabel}${executionLabel}：${formatPrice(action.price)}${inferredLabel}`;
}

function timeValue(iso: string | number | null | undefined) {
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function locateCandle(candles: Candle[], targetMs: number) {
  if (!candles.length) return 0;
  const targetSeconds = Math.floor(targetMs / 1000);
  let low = 0;
  let high = candles.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time <= targetSeconds) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function hashSymbol(symbol: string) {
  return [...symbol].reduce((hash, character) => {
    return (hash * 31 + character.charCodeAt(0)) >>> 0;
  }, 2166136261);
}

function generateDemoCandles(trade: ReplayTrade, frame: TimeFrame): Candle[] {
  const intervalMs = FRAME_MS[frame];
  const entryMs = timeValue(trade.entryTime) ?? Date.now() - intervalMs * 120;
  const entryIndex = EMA_WARMUP_CANDLES;
  const lastExit = trade.exits
    .map((exit) => timeValue(exit.exitTime))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
    .at(-1);
  const rawExitIndex = lastExit
    ? entryIndex + Math.round((lastExit - entryMs) / intervalMs)
    : entryIndex + 220;
  const exitIndex = Math.min(Math.max(rawExitIndex, entryIndex + 1), 900);
  const count = Math.min(Math.max(exitIndex + 64, 360), 980);
  const targetExit = trade.exits.at(-1)?.exitPrice ??
    trade.entryPrice * (trade.side === "long" ? 1.06 : 0.94);
  const trend = (targetExit - trade.entryPrice) / Math.max(exitIndex - entryIndex, 1);
  const seed = hashSymbol(trade.symbol);
  const amplitude = trade.entryPrice * (0.0038 + (seed % 7) * 0.00035);
  const startTime = entryMs - entryIndex * intervalMs;
  const candles: Candle[] = [];
  let previousClose = trade.entryPrice - trend * entryIndex;

  for (let index = 0; index < count; index += 1) {
    const relative = index - entryIndex;
    const wave =
      Math.sin((index + (seed % 17)) * 0.39) * amplitude +
      Math.sin((index + (seed % 29)) * 0.11) * amplitude * 0.7;
    const center = trade.entryPrice + trend * relative + wave;
    const close = index === entryIndex ? trade.entryPrice : center;
    const open = index === entryIndex ? previousClose : previousClose;
    const wick = amplitude * (0.45 + ((index * 13 + seed) % 19) / 25);
    const high = Math.max(open, close) + wick;
    const low = Math.max(0.000001, Math.min(open, close) - wick * 0.85);
    const time = Math.floor((startTime + index * intervalMs) / 1000);
    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume: 900 + ((index * 97 + seed) % 2_800),
      closeTime: (time + intervalMs / 1000) * 1000 - 1,
    });
    previousClose = close;
  }
  return candles;
}

function sanitizeImportedTrade(
  trade: NormalizedTrade,
  index: number,
  syncSource: "manual-csv" | "manual-json",
  profile: TradeProfile,
): ReplayTrade {
  if (!trade.entryTime || !timeValue(trade.entryTime)) {
    throw new Error(`第 ${index + 1} 笔交易缺少有效的入场时间。`);
  }
  const symbol = normalizeSymbol(trade.symbol);
  const [profiledTrade] = assignTradeProfile([{
    ...trade,
    symbol,
    id: `import-${profile.id}-${Date.now()}-${index}`,
    title: "导入交易",
    strategy: "待归类",
    notes: "",
    syncSources: [syncSource],
  }], profile, { omitDefault: true });
  return profiledTrade as ReplayTrade;
}

function finalTradePnl(trade: ReplayTrade) {
  const fallbackPrice =
    trade.openPosition?.markPrice ?? trade.exits.at(-1)?.exitPrice ?? trade.entryPrice;
  try {
    return calculateTradePnl(trade, fallbackPrice);
  } catch {
    return EMPTY_PNL;
  }
}

function CandleReplayChart({
  candles,
  openInterest,
  cursor,
  candlePhase,
  currentCandle,
  entryIndex,
  trade,
  indicatorVisibility,
  volumeColoringConfig,
  orderFlowAvailable,
}: {
  candles: Candle[];
  openInterest: OpenInterestPoint[];
  cursor: number;
  candlePhase: number;
  currentCandle: Candle | undefined;
  entryIndex: number;
  trade: ReplayTrade;
  indicatorVisibility: IndicatorVisibility;
  volumeColoringConfig: VolumeColoringConfig;
  orderFlowAvailable: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema200SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const xinWt1SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const xinWt2SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const xinMfiSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const xinMomentumSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const xinMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const openInterestSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const deltaSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const cvdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const priceLineKeyRef = useRef("");
  const renderedCursorRef = useRef(-1);
  const dataKeyRef = useRef("");
  const openInterestDataKeyRef = useRef("");
  const [ready, setReady] = useState(false);
  const showOpenInterest = indicatorVisibility.openInterest && openInterest.length > 0;
  const showOrderFlow = orderFlowAvailable;

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let chart: IChartApi | null = null;

    void (async () => {
      const library = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      const chartBackground = "#ffffff";
      const chartText = "#667085";
      const chartBorder = "rgba(17, 24, 39, 0.16)";
      const chartSeparator = "rgba(17, 24, 39, 0.12)";
      const candleColor = "#111111";

      chart = library.createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: library.ColorType.Solid, color: chartBackground },
          textColor: chartText,
          attributionLogo: false,
          panes: {
            enableResize: true,
            separatorColor: chartSeparator,
            separatorHoverColor: "rgba(41, 98, 255, 0.22)",
          },
        },
        grid: {
          vertLines: { color: "transparent" },
          horzLines: { color: "transparent" },
        },
        crosshair: {
          mode: library.CrosshairMode.Normal,
          vertLine: { color: "rgba(17, 24, 39, 0.22)", labelBackgroundColor: "#475467" },
          horzLine: { color: "rgba(17, 24, 39, 0.18)", labelBackgroundColor: "#475467" },
        },
        rightPriceScale: {
          borderColor: chartBorder,
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          borderColor: chartBorder,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 8,
          barSpacing: 8,
          minBarSpacing: 3,
          fixLeftEdge: true,
        },
        handleScroll: { vertTouchDrag: false },
        localization: {
          locale: "zh-CN",
          priceFormatter: formatPrice,
        },
      });

      const series = chart.addSeries(library.CandlestickSeries, {
        upColor: "transparent",
        downColor: candleColor,
        borderVisible: true,
        borderUpColor: candleColor,
        borderDownColor: candleColor,
        wickUpColor: candleColor,
        wickDownColor: candleColor,
        priceLineVisible: true,
        priceLineColor: "#2962ff",
        priceLineWidth: 1,
        priceLineStyle: library.LineStyle.Dotted,
        lastValueVisible: true,
      }, 0);
      const ema21Series = indicatorVisibility.ema21
        ? chart.addSeries(library.LineSeries, {
            priceScaleId: "right",
            color: "#e58b18",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, 0)
        : null;
      const ema200Series = indicatorVisibility.ema200
        ? chart.addSeries(library.LineSeries, {
            priceScaleId: "right",
            color: "#8b5cf6",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, 0)
        : null;
      let nextPaneIndex = 1;
      const xinPaneIndex = indicatorVisibility.xinMentorship
        ? nextPaneIndex++
        : null;
      const volumePaneIndex = indicatorVisibility.volume ? nextPaneIndex++ : null;
      const openInterestPaneIndex = showOpenInterest ? nextPaneIndex++ : null;
      const deltaPaneIndex = indicatorVisibility.delta && showOrderFlow ? nextPaneIndex++ : null;
      const cvdPaneIndex = indicatorVisibility.cvd && showOrderFlow ? nextPaneIndex++ : null;
      const xinMomentumSeries = xinPaneIndex === null
        ? null
        : chart.addSeries(library.HistogramSeries, {
            priceScaleId: "right",
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            priceLineVisible: false,
            lastValueVisible: false,
            base: 0,
          }, xinPaneIndex);
      const xinMfiSeries = xinPaneIndex === null
        ? null
        : chart.addSeries(library.AreaSeries, {
            priceScaleId: "right",
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            lineColor: "rgba(0, 230, 118, 0.42)",
            topColor: "rgba(0, 230, 118, 0.16)",
            bottomColor: "rgba(255, 23, 68, 0.10)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, xinPaneIndex);
      const xinWt1Series = xinPaneIndex === null
        ? null
        : chart.addSeries(library.LineSeries, {
            priceScaleId: "right",
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            color: "#4994ec",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: true,
          }, xinPaneIndex);
      const xinWt2Series = xinPaneIndex === null
        ? null
        : chart.addSeries(library.LineSeries, {
            priceScaleId: "right",
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            color: "rgba(26, 35, 126, 0.78)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, xinPaneIndex);
      const volumeSeries = volumePaneIndex === null
        ? null
        : chart.addSeries(library.HistogramSeries, {
            priceScaleId: "right",
            priceFormat: { type: "volume" },
            priceLineVisible: false,
            lastValueVisible: true,
            base: 0,
          }, volumePaneIndex);
      const openInterestSeries = openInterestPaneIndex === null
        ? null
        : chart.addSeries(library.LineSeries, {
            priceScaleId: "right",
            priceFormat: { type: "volume" },
            color: "#2962ff",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: true,
          }, openInterestPaneIndex);
      const deltaSeries = deltaPaneIndex === null
        ? null
        : chart.addSeries(library.HistogramSeries, {
            priceScaleId: "right",
            priceFormat: { type: "volume" },
            priceLineVisible: false,
            lastValueVisible: true,
            base: 0,
          }, deltaPaneIndex);
      const cvdSeries = cvdPaneIndex === null
        ? null
        : chart.addSeries(library.LineSeries, {
            priceScaleId: "right",
            priceFormat: { type: "volume" },
            color: "#0f9f8f",
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: true,
          }, cvdPaneIndex);
      const markers = library.createSeriesMarkers(series, [], { autoScale: true });
      const xinMarkers = xinWt1Series
        ? library.createSeriesMarkers(xinWt1Series, [], { autoScale: true })
        : null;
      if (xinWt1Series) {
        [
          { price: 60, color: "rgba(255, 23, 68, 0.22)", title: "OB2" },
          { price: 53, color: "rgba(255, 23, 68, 0.34)", title: "OB1" },
          { price: 0, color: "rgba(120, 144, 156, 0.42)", title: "0" },
          { price: -53, color: "rgba(0, 230, 118, 0.34)", title: "OS1" },
          { price: -60, color: "rgba(0, 230, 118, 0.22)", title: "OS2" },
        ].forEach((level) => {
          xinWt1Series.createPriceLine({
            ...level,
            lineWidth: 1,
            lineStyle: library.LineStyle.Dashed,
            axisLabelVisible: false,
          });
        });
      }

      series.priceScale().applyOptions({
        borderColor: chartBorder,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      });
      volumeSeries?.priceScale().applyOptions({
        borderColor: chartBorder,
        scaleMargins: { top: 0.08, bottom: 0.03 },
      });
      openInterestSeries?.priceScale().applyOptions({
        borderColor: chartBorder,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      });
      deltaSeries?.priceScale().applyOptions({
        borderColor: chartBorder,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      });
      cvdSeries?.priceScale().applyOptions({
        borderColor: chartBorder,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      });
      xinWt1Series?.priceScale().applyOptions({
        borderColor: chartBorder,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      });
      const panes = chart.panes();
      panes[0]?.setStretchFactor(4);
      if (xinPaneIndex !== null) panes[xinPaneIndex]?.setStretchFactor(2);
      if (volumePaneIndex !== null) panes[volumePaneIndex]?.setStretchFactor(1);
      if (openInterestPaneIndex !== null) panes[openInterestPaneIndex]?.setStretchFactor(1.15);
      if (deltaPaneIndex !== null) panes[deltaPaneIndex]?.setStretchFactor(1);
      if (cvdPaneIndex !== null) panes[cvdPaneIndex]?.setStretchFactor(1.15);

      chartRef.current = chart;
      seriesRef.current = series;
      ema21SeriesRef.current = ema21Series;
      ema200SeriesRef.current = ema200Series;
      xinWt1SeriesRef.current = xinWt1Series;
      xinWt2SeriesRef.current = xinWt2Series;
      xinMfiSeriesRef.current = xinMfiSeries;
      xinMomentumSeriesRef.current = xinMomentumSeries;
      xinMarkersRef.current = xinMarkers;
      volumeSeriesRef.current = volumeSeries;
      openInterestSeriesRef.current = openInterestSeries;
      deltaSeriesRef.current = deltaSeries;
      cvdSeriesRef.current = cvdSeries;
      markersRef.current = markers;
      resizeObserver = new ResizeObserver(() => {
        if (containerRef.current && chart) {
          chart.applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      resizeObserver.observe(containerRef.current);
      setReady(true);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      ema21SeriesRef.current = null;
      ema200SeriesRef.current = null;
      xinWt1SeriesRef.current = null;
      xinWt2SeriesRef.current = null;
      xinMfiSeriesRef.current = null;
      xinMomentumSeriesRef.current = null;
      xinMarkersRef.current = null;
      volumeSeriesRef.current = null;
      openInterestSeriesRef.current = null;
      deltaSeriesRef.current = null;
      cvdSeriesRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
      priceLineKeyRef.current = "";
      renderedCursorRef.current = -1;
      dataKeyRef.current = "";
      openInterestDataKeyRef.current = "";
    };
  }, [indicatorVisibility, showOpenInterest, showOrderFlow]);

  useEffect(() => {
    const series = seriesRef.current;
    const ema21Series = ema21SeriesRef.current;
    const ema200Series = ema200SeriesRef.current;
    const xinWt1Series = xinWt1SeriesRef.current;
    const xinWt2Series = xinWt2SeriesRef.current;
    const xinMfiSeries = xinMfiSeriesRef.current;
    const xinMomentumSeries = xinMomentumSeriesRef.current;
    const xinMarkerApi = xinMarkersRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const openInterestSeries = openInterestSeriesRef.current;
    const deltaSeries = deltaSeriesRef.current;
    const cvdSeries = cvdSeriesRef.current;
    const markerApi = markersRef.current;
    const chart = chartRef.current;
    if (!ready || !series || !markerApi || !chart || !candles.length || !currentCandle) return;

    const safeCursor = Math.min(Math.max(cursor, 0), candles.length - 1);
    const replayTimeMs = getReplayTimeMs(
      candles[safeCursor],
      candlePhase,
      candles[safeCursor + 1],
    );
    const replaySnapshot = buildReplayTradeSnapshot(
      trade,
      replayTimeMs,
      currentCandle.close,
    );
    const replayPriceLines = replaySnapshot.averageEntryPrice === null
      ? []
      : getReplayPriceLines(
          {
            ...trade,
            entryPrice: replaySnapshot.averageEntryPrice,
          },
          replayTimeMs,
        );
    const priceLineKey = `${trade.id}:${replayPriceLines
      .map((line) => `${line.id}:${line.kind}:${line.price}:${line.label}`)
      .join("|")}`;
    if (priceLineKeyRef.current !== priceLineKey) {
      for (const line of priceLinesRef.current) series.removePriceLine(line);
      priceLinesRef.current = replayPriceLines.map((line) =>
        series.createPriceLine({
          price: line.price,
          color:
            line.kind === "cost"
              ? "#b77900"
              : line.kind === "takeProfit"
                ? "rgba(48, 196, 135, 0.88)"
                : "rgba(239, 101, 114, 0.88)",
          lineWidth: line.kind === "cost" ? 2 : 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: line.label,
        }),
      );
      priceLineKeyRef.current = priceLineKey;
    }
    const volumeColoringKey = indicatorVisibility.volumeColoring
      ? `${volumeColoringConfig.rvolPeriod}:${volumeColoringConfig.lookback}`
      : "off";
    const dataKey = `${candles[0].time}:${candles.length}:${trade.id}:${volumeColoringKey}`;
    const currentReplayVolume = getReplayVolume(candles[safeCursor].volume, candlePhase);
    const volumeColorPoints = indicatorVisibility.volumeColoring
      ? buildVolumeCandleColorSeries(
          [
            ...candles.slice(0, safeCursor),
            { ...currentCandle, volume: currentReplayVolume },
          ],
          volumeColoringConfig,
        ).points
      : [];
    const volumeColorByTime = new Map(
      volumeColorPoints.map((point) => [point.time, point.tone] as const),
    );
    const toChartBar = (candle: Candle): CandlestickData<UTCTimestamp> => ({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      ...(() => {
        const tone = volumeColorByTime.get(candle.time);
        const fillColor = tone
          ? VOLUME_CANDLE_COLORS[tone]
          : candle.close >= candle.open ? "transparent" : "#111111";
        return {
          color: fillColor,
          borderColor: "#111111",
          wickColor: "#111111",
        };
      })(),
    });
    const nextBar = toChartBar(currentCandle);
    const volumeColor = currentCandle.close >= currentCandle.open
      ? "rgba(48, 196, 135, 0.58)"
      : "rgba(239, 101, 114, 0.58)";
    const toVolumeBar = (candle: Candle) => ({
      time: candle.time as UTCTimestamp,
      value: candle.volume,
      color: candle.close >= candle.open
        ? "rgba(48, 196, 135, 0.58)"
        : "rgba(239, 101, 114, 0.58)",
    });
    const nextVolumeBar = {
      time: candles[safeCursor].time as UTCTimestamp,
      value: currentReplayVolume,
      color: volumeColor,
    };
    const previousCursor = renderedCursorRef.current;
    const chartStartIndex = Math.max(0, entryIndex - CHART_PRE_ENTRY_CANDLES);
    const chartStartTime = candles[chartStartIndex].time;
    const ema21Data = buildReplayEmaSeries(candles, safeCursor, currentCandle.close, 21)
      .filter((point) => point.time >= chartStartTime)
      .map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
    const ema200Data = buildReplayEmaSeries(candles, safeCursor, currentCandle.close, 200)
      .filter((point) => point.time >= chartStartTime)
      .map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
    const canUpdate =
      dataKeyRef.current === dataKey &&
      (previousCursor === safeCursor || previousCursor + 1 === safeCursor);

    if (canUpdate) {
      series.update(nextBar);
      volumeSeries?.update(nextVolumeBar);
      const nextEma21 = ema21Data.at(-1);
      const nextEma200 = ema200Data.at(-1);
      if (nextEma21) ema21Series?.update(nextEma21);
      if (nextEma200) ema200Series?.update(nextEma200);
    } else {
      series.setData([
        ...candles.slice(chartStartIndex, safeCursor).map(toChartBar),
        nextBar,
      ]);
      volumeSeries?.setData([
        ...candles.slice(chartStartIndex, safeCursor).map(toVolumeBar),
        nextVolumeBar,
      ]);
      ema21Series?.setData(ema21Data);
      ema200Series?.setData(ema200Data);
    }
    dataKeyRef.current = dataKey;
    renderedCursorRef.current = safeCursor;

    if (deltaSeries || cvdSeries) {
      const orderFlow = buildReplayOrderFlowSeries(
        candles.slice(chartStartIndex),
        safeCursor - chartStartIndex,
        candlePhase,
      );
      deltaSeries?.setData(orderFlow.delta.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.value,
        color: point.value >= 0
          ? "rgba(48, 196, 135, 0.72)"
          : "rgba(239, 101, 114, 0.72)",
      })));
      cvdSeries?.setData(orderFlow.cvd.map((point) => ({
        time: point.time as UTCTimestamp,
        value: point.value,
      })));
    }

    if (
      xinWt1Series &&
      xinWt2Series &&
      xinMfiSeries &&
      xinMomentumSeries &&
      xinMarkerApi
    ) {
      const xin = buildReplayXinMentorshipSeries(
        candles,
        safeCursor,
        currentCandle,
      );
      const xinPoints = xin.points.filter(
        (point) => point.time >= chartStartTime,
      );
      xinWt1Series.setData(xinPoints.flatMap((point) =>
        point.wt1 === null
          ? []
          : [{
              time: point.time as UTCTimestamp,
              value: point.wt1,
              color: point.wt1 > xin.config.overbought2
                ? "rgba(255, 23, 68, 0.90)"
                : point.wt1 > xin.config.overbought1
                  ? "rgba(255, 23, 68, 0.62)"
                  : point.wt1 < xin.config.oversold2
                    ? "rgba(0, 230, 118, 0.90)"
                    : point.wt1 < xin.config.oversold1
                      ? "rgba(0, 230, 118, 0.62)"
                      : "rgba(73, 148, 236, 0.76)",
            }],
      ));
      xinWt2Series.setData(xinPoints.flatMap((point) =>
        point.wt2 === null
          ? []
          : [{ time: point.time as UTCTimestamp, value: point.wt2 }],
      ));
      xinMfiSeries.setData(xinPoints.flatMap((point) =>
        point.mfi === null
          ? []
          : [{
              time: point.time as UTCTimestamp,
              value: point.mfi,
              lineColor: point.mfi >= 0
                ? "rgba(0, 230, 118, 0.46)"
                : "rgba(255, 23, 68, 0.46)",
              topColor: point.mfi >= 0
                ? "rgba(0, 230, 118, 0.16)"
                : "rgba(255, 23, 68, 0.05)",
              bottomColor: point.mfi >= 0
                ? "rgba(0, 230, 118, 0.03)"
                : "rgba(255, 23, 68, 0.14)",
            }],
      ));
      xinMomentumSeries.setData(xinPoints.flatMap((point) =>
        point.momentum === null
          ? []
          : [{
              time: point.time as UTCTimestamp,
              value: point.momentum,
              color: point.momentum >= 0
                ? point.momentumDelta !== null && point.momentumDelta > 0
                  ? "rgba(0, 230, 118, 0.78)"
                  : "rgba(0, 230, 118, 0.34)"
                : point.momentumDelta !== null && point.momentumDelta < 0
                  ? "rgba(255, 23, 68, 0.78)"
                  : "rgba(255, 23, 68, 0.34)",
            }],
      ));
      const xinMarkers: SeriesMarker<Time>[] = [];
      xinPoints.forEach((point) => {
        if (point.signal) {
          const buy = point.signal.includes("buy");
          const strong = point.signal.startsWith("strong");
          xinMarkers.push({
            id: `xin-${point.signal}-${point.time}`,
            time: point.time as UTCTimestamp,
            position: buy ? "belowBar" : "aboveBar",
            color: point.signal === "gold-buy"
              ? "#ffd600"
              : buy ? "#00c853" : "#d50000",
            shape: buy ? "arrowUp" : "arrowDown",
            text: point.signal === "gold-buy"
              ? "GOLD"
              : strong ? (buy ? "BUY+" : "SELL+") : (buy ? "B" : "S"),
            size: strong || point.signal === "gold-buy" ? 1.4 : 1,
          });
        }
        if (point.preBearWarning || point.preBullWarning) {
          const bullish = point.preBullWarning;
          xinMarkers.push({
            id: `xin-warning-${point.time}`,
            time: point.time as UTCTimestamp,
            position: bullish ? "belowBar" : "aboveBar",
            color: bullish ? "#00bfa5" : "#ff9100",
            shape: bullish ? "arrowUp" : "arrowDown",
            text: bullish ? "BLDG" : "WEAK",
            size: 0.8,
          });
        }
        if (
          point.divergenceTime !== null &&
          point.divergenceValue !== null &&
          (point.bullishDivergence || point.bearishDivergence)
        ) {
          const bullish = point.bullishDivergence;
          xinMarkers.push({
            id: `xin-div-${point.divergenceTime}-${bullish ? "bull" : "bear"}`,
            time: point.divergenceTime as UTCTimestamp,
            position: bullish ? "belowBar" : "aboveBar",
            color: bullish ? "#00e676" : "#ff1744",
            shape: "circle",
            text: "DIV",
            size: 0.8,
          });
        }
      });
      xinMarkers.sort((left, right) => Number(left.time) - Number(right.time));
      xinMarkerApi.setMarkers(xinMarkers);
    }

    if (openInterestSeries) {
      const visibleOpenInterest = getReplayOpenInterestPoints(openInterest, replayTimeMs)
        .filter((point) => point.time >= chartStartTime && point.time <= candles[safeCursor].time);
      const lastPoint = visibleOpenInterest.at(-1);
      const openInterestDataKey = `${openInterest[0]?.time ?? ""}:${openInterest.at(-1)?.time ?? ""}:${lastPoint?.time ?? ""}:${lastPoint?.openInterest ?? ""}:${visibleOpenInterest.length}`;
      if (openInterestDataKeyRef.current !== openInterestDataKey) {
        openInterestSeries.setData(visibleOpenInterest.map((point) => ({
          time: point.time as UTCTimestamp,
          value: point.openInterest,
        })));
        openInterestDataKeyRef.current = openInterestDataKey;
      }
    }

    const markers: SeriesMarker<Time>[] = [];
    replaySnapshot.visibleEntries.forEach((entry, index) => {
      const entryMs = timeValue(entry.entryTime);
      if (entryMs === null) return;
      const visibleEntryIndex = locateCandle(candles, entryMs);
      const entryIsBuy = trade.side === "long";
      markers.push({
        id: `entry-${trade.id}-${index}`,
        time: candles[visibleEntryIndex].time as UTCTimestamp,
        position: entryIsBuy ? "belowBar" : "aboveBar",
        color: entryIsBuy ? "#30c487" : "#ef6572",
        shape: entryIsBuy ? "arrowUp" : "arrowDown",
        size: 1.5,
      });
    });

    replaySnapshot.visibleExits.forEach((exit, index) => {
      const exitMs = timeValue(exit.exitTime);
      if (exitMs === null) return;
      const exitIndex = locateCandle(candles, exitMs);
      const exitIsBuy = trade.side === "short";
      markers.push({
        id: `exit-${trade.id}-${index}`,
        time: candles[exitIndex].time as UTCTimestamp,
        position: exitIsBuy ? "belowBar" : "aboveBar",
        color: exitIsBuy ? "#30c487" : "#ef6572",
        shape: exitIsBuy ? "arrowUp" : "arrowDown",
        size: 1.5,
      });
    });

    markers.sort((a, b) => Number(a.time) - Number(b.time));
    markerApi.setMarkers(markers);

    if (safeCursor <= entryIndex || previousCursor < 0) {
      chart.timeScale().fitContent();
    } else if (previousCursor !== safeCursor) {
      chart.timeScale().scrollToRealTime();
    }
  }, [
    candlePhase,
    candles,
    currentCandle,
    cursor,
    entryIndex,
    indicatorVisibility.volumeColoring,
    openInterest,
    ready,
    trade,
    volumeColoringConfig,
  ]);

  return (
    <div className="chart-canvas-wrap">
      <div ref={containerRef} className="chart-canvas" aria-hidden="true" />
      {!ready && <div className="chart-placeholder">正在准备图表…</div>}
    </div>
  );
}

export function TradeReplay() {
  const [trades, setTrades] = useState<ReplayTrade[]>(DEFAULT_TRADES);
  const [orderArchive, setOrderArchive] = useState<BinanceOrderRecord[]>([]);
  const [profiles, setProfiles] = useState<TradeProfile[]>(() => normalizeTradeProfiles([]));
  const [activeProfileId, setActiveProfileId] = useState<string>(
    DEFAULT_TRADE_PROFILE_ID,
  );
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [profileCreateError, setProfileCreateError] = useState("");
  const [trainingResults, setTrainingResults] = useState<TrainingResultRecord[]>([]);
  const [selectedId, setSelectedId] = useState(DEFAULT_TRADES[0].id);
  const [activeModule, setActiveModule] = useState<ActiveModule>("replay");
  const [frame, setFrame] = useState<TimeFrame>("5m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [openInterest, setOpenInterest] = useState<OpenInterestPoint[]>([]);
  const [openInterestStatus, setOpenInterestStatus] = useState<OpenInterestStatus>("idle");
  const [openInterestNotice, setOpenInterestNotice] = useState("");
  const [replayFrame, setReplayFrame] = useState({ cursor: 0, phase: 0 });
  const [entryIndex, setEntryIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [indicatorVisibility, setIndicatorVisibility] = useState<IndicatorVisibility>(
    DEFAULT_INDICATOR_VISIBILITY,
  );
  const [volumeColoringConfig, setVolumeColoringConfig] = useState<VolumeColoringConfig>(
    DEFAULT_VOLUME_COLORING_CONFIG,
  );
  const [appTheme, setAppTheme] = useState<AppTheme>("dark");
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("正在获取行情");
  const [dataNotice, setDataNotice] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>("loading");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileDialogRef = useRef<HTMLDialogElement>(null);
  const orderArchiveRef = useRef<BinanceOrderRecord[]>([]);
  const tradesRef = useRef<ReplayTrade[]>(DEFAULT_TRADES);
  const publicLeadSyncingRef = useRef<Set<string>>(new Set());
  const pendingTimeframeReplayRef = useRef<{
    tradeId: string;
    frame: TimeFrame;
    timeMs: number;
    playing: boolean;
  } | null>(null);

  const mergeIntoOrderArchive = useCallback((incomingOrders: unknown) => {
    const mergedOrders = mergeBinanceOrderRecords(
      orderArchiveRef.current,
      incomingOrders,
    );
    // 两家交易所可同时完成更新；先同步 ref，避免后完成的回调读取旧闭包并覆盖另一家订单。
    orderArchiveRef.current = mergedOrders;
    setOrderArchive(mergedOrders);
    return mergedOrders;
  }, []);

  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ??
    profiles[0] ??
    normalizeTradeProfiles([])[0];
  const activeProfileTrades = useMemo(
    () => filterRecordsByTradeProfile<ReplayTrade>(trades, activeProfile.id),
    [activeProfile.id, trades],
  );
  const trade = activeProfileTrades.find((item) => item.id === selectedId) ??
    activeProfileTrades[0] ??
    DEFAULT_TRADES[0];
  const archiveTrades = useMemo(() => {
    const importedTrades = activeProfileTrades.filter((item) => item.id.startsWith("import-"));
    return importedTrades.length > 0
      ? importedTrades
      : activeProfile.id === DEFAULT_TRADE_PROFILE_ID
        ? activeProfileTrades
        : [];
  }, [activeProfile.id, activeProfileTrades]);
  const activeProfileOrders = useMemo(
    () => filterRecordsByTradeProfile<BinanceOrderRecord>(orderArchive, activeProfile.id),
    [activeProfile.id, orderArchive],
  );
  const binanceApiSymbols = useMemo(
    () => [...new Set([
      ...activeProfileOrders.map((order) => normalizeSymbol(order.symbol)),
      ...archiveTrades.map((item) => normalizeSymbol(item.symbol)),
    ])].sort(),
    [activeProfileOrders, archiveTrades],
  );
  const closeDateGroups = useMemo(
    () => groupTradesByCloseDate(archiveTrades),
    [archiveTrades],
  );
  const filteredTrades = useMemo(
    () => filterTradesByCloseDate(archiveTrades, selectedDate),
    [archiveTrades, selectedDate],
  );
  const cursor = replayFrame.cursor;
  const candlePhase = replayFrame.phase;
  const replayMarketDataKey = buildReplayMarketDataKey(trade, frame);

  useEffect(() => {
    const dialog = profileDialogRef.current;
    if (!dialog) return;
    if (profileDialogOpen && !dialog.open) dialog.showModal();
    if (!profileDialogOpen && dialog.open) dialog.close();
  }, [profileDialogOpen]);

  useEffect(() => {
    if (selectedDate && !closeDateGroups.some((group) => group.date === selectedDate)) {
      setSelectedDate(null);
      return;
    }

    if (
      filteredTrades.length > 0 &&
      !filteredTrades.some((item) => item.id === selectedId)
    ) {
      if (
        selectedDate !== null &&
        archiveTrades.some((item) => item.id === selectedId)
      ) {
        setSelectedDate(null);
        return;
      }
      setSelectedId(filteredTrades[0].id);
      setPlaying(false);
    }
  }, [archiveTrades, closeDateGroups, filteredTrades, selectedDate, selectedId]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let restoredTrades = DEFAULT_TRADES;
      let restoredOrders: BinanceOrderRecord[] = [];
      let restoredOpenPositions: BinanceOpenPosition[] = [];
      let restoredTrainingResults: TrainingResultRecord[] = [];
      let restoredProfiles = normalizeTradeProfiles([]);
      let restoredActiveProfileId: string = DEFAULT_TRADE_PROFILE_ID;
      let restoreNotice = "";

      try {
        const saved = window.localStorage.getItem(TRADES_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as unknown;
          restoredTrades = mergeDefaultAndImportedTrades(DEFAULT_TRADES, parsed);
        }
      } catch {
        // 浏览器复盘数据损坏时使用内置示例，不阻断桌面数据库恢复。
      }

      try {
        const savedOrders = window.localStorage.getItem(ORDER_HISTORY_STORAGE_KEY);
        if (savedOrders) {
          const parsedOrders = JSON.parse(savedOrders) as unknown;
          if (!Array.isArray(parsedOrders)) throw new Error("订单存档格式无效");
          restoredOrders = mergeBinanceOrderRecords([], parsedOrders);
        }
      } catch {
        restoreNotice = "浏览器中的 Binance U 本位订单存档损坏，已保留其它可用复盘。";
      }

      try {
        const savedTrainingResults = window.localStorage.getItem(TRAINING_RESULTS_STORAGE_KEY);
        if (savedTrainingResults) {
          const parsedResults = JSON.parse(savedTrainingResults) as unknown;
          if (!Array.isArray(parsedResults)) throw new Error("训练成绩格式无效");
          restoredTrainingResults = mergeTrainingResults(parsedResults);
        }
      } catch {
        restoreNotice = "浏览器中的训练成绩损坏，已保留其它可用数据。";
      }

      try {
        const savedProfiles = window.localStorage.getItem(TRADE_PROFILES_STORAGE_KEY);
        if (savedProfiles) {
          restoredProfiles = normalizeTradeProfiles(JSON.parse(savedProfiles));
        }
        const savedActiveProfile = window.localStorage.getItem(
          ACTIVE_TRADE_PROFILE_STORAGE_KEY,
        );
        if (savedActiveProfile) restoredActiveProfileId = savedActiveProfile;
      } catch {
        restoreNotice = "浏览器中的复盘用户列表损坏，已恢复默认用户。";
      }

      const desktopApi = window.cryptoReviewDesktop;
      let nextPersistenceMode: PersistenceMode = "browser";

      if (desktopApi) {
        try {
          const desktopState = await desktopApi.loadState();
          if (
            !Array.isArray(desktopState.orders) ||
            !Array.isArray(desktopState.trades) ||
            !Array.isArray(desktopState.openPositions) ||
            !Array.isArray(desktopState.trainingResults)
          ) {
            throw new Error("桌面存档格式无效");
          }
          restoredTrades = mergeDesktopAndBrowserTrades(
            restoredTrades,
            desktopState.trades,
          );
          restoredOrders = mergeBinanceOrderRecords(
            restoredOrders,
            desktopState.orders,
          );
          restoredOpenPositions = desktopState.openPositions;
          restoredTrainingResults = mergeTrainingResults(
            restoredTrainingResults,
            desktopState.trainingResults,
          );
          restoredProfiles = normalizeTradeProfiles([
            ...restoredProfiles,
            ...(Array.isArray(desktopState.profiles) ? desktopState.profiles : []),
          ]);
          nextPersistenceMode = "desktop";
        } catch {
          nextPersistenceMode = "browser";
          restoreNotice = "桌面数据读取失败，已回退浏览器本地存储；导入记录和复盘笔记仍会保存在当前设备。";
        }
      }

      if (restoredOrders.length > 0) {
        const reconstruction = reconstructReplayableBinanceOrders(
          restoredOrders,
          {
            openPositions: restoredOpenPositions,
          },
        );
        restoredTrades = mergeImportedReplays(restoredTrades, reconstruction.trades);
      }

      if (cancelled) return;
      if (!restoredProfiles.some((profile) => profile.id === restoredActiveProfileId)) {
        restoredActiveProfileId = DEFAULT_TRADE_PROFILE_ID;
      }
      orderArchiveRef.current = restoredOrders;
      tradesRef.current = restoredTrades;
      setOrderArchive(restoredOrders);
      setTrades(restoredTrades);
      setTrainingResults(restoredTrainingResults);
      setProfiles(restoredProfiles);
      setActiveProfileId(restoredActiveProfileId);
      const restoredProfileTrades = filterRecordsByTradeProfile<ReplayTrade>(
        restoredTrades,
        restoredActiveProfileId,
      );
      setSelectedId(restoredProfileTrades[0]?.id ?? DEFAULT_TRADES[0].id);
      setPersistenceMode(nextPersistenceMode);
      setHydrated(true);
      if (restoreNotice) setImportNotice(restoreNotice);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || persistenceMode === "loading") return;

    try {
      window.localStorage.setItem(TRADE_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
      window.localStorage.setItem(ACTIVE_TRADE_PROFILE_STORAGE_KEY, activeProfile.id);
    } catch {
      setImportNotice("复盘用户保存失败；当前页面仍可继续使用。");
    }

    if (persistenceMode !== "desktop") return;
    const desktopApi = window.cryptoReviewDesktop;
    if (!desktopApi) return;
    let cancelled = false;
    void desktopApi.saveProfiles(profiles).catch(() => {
      if (!cancelled) {
        setImportNotice("桌面复盘用户保存失败，请检查本地数据库是否可写。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeProfile.id, hydrated, persistenceMode, profiles]);

  useEffect(() => {
    if (!hydrated) return;
    if (persistenceMode === "loading") return;

    if (persistenceMode === "browser") {
      try {
        window.localStorage.setItem(TRADES_STORAGE_KEY, JSON.stringify(trades));
      } catch {
        setImportNotice("本地保存失败，浏览器存储空间可能不足；本次记录仍可在当前页面使用。");
      }
      return;
    }

    const desktopApi = window.cryptoReviewDesktop;
    if (!desktopApi) {
      setImportNotice("桌面保存接口不可用，本次修改仍保留在当前页面。");
      return;
    }

    let cancelled = false;
    void desktopApi.saveTrades(trades).catch(() => {
      if (!cancelled) {
        setImportNotice("桌面复盘保存失败，请检查本地数据库是否可写；本次修改仍保留在当前页面。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, persistenceMode, trades]);

  useEffect(() => {
    if (!hydrated) return;
    if (persistenceMode === "loading") return;

    if (persistenceMode === "browser") {
      try {
        window.localStorage.setItem(
          ORDER_HISTORY_STORAGE_KEY,
          JSON.stringify(orderArchive),
        );
      } catch {
        setImportNotice("本地保存失败，浏览器存储空间可能不足；本次记录仍可在当前页面使用。");
      }
      return;
    }

    const desktopApi = window.cryptoReviewDesktop;
    if (!desktopApi) {
      setImportNotice("桌面保存接口不可用，本次修改仍保留在当前页面。");
      return;
    }

    let cancelled = false;
    void desktopApi.saveOrders(orderArchive).catch(() => {
      if (!cancelled) {
        setImportNotice("桌面订单保存失败，请检查本地数据库是否可写；本次修改仍保留在当前页面。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, orderArchive, persistenceMode]);

  useEffect(() => {
    if (!hydrated) return;
    if (persistenceMode === "loading") return;

    if (persistenceMode === "browser") {
      try {
        window.localStorage.setItem(
          TRAINING_RESULTS_STORAGE_KEY,
          JSON.stringify(trainingResults),
        );
      } catch {
        setImportNotice("训练成绩保存失败，浏览器存储空间可能不足；本次结果仍可在当前页面查看。");
      }
      return;
    }

    const desktopApi = window.cryptoReviewDesktop;
    if (!desktopApi) {
      setImportNotice("桌面训练成绩保存接口不可用，本次结果仍保留在当前页面。");
      return;
    }

    let cancelled = false;
    void desktopApi.saveTrainingResults(trainingResults).catch(() => {
      if (!cancelled) {
        setImportNotice("桌面训练成绩保存失败，请检查本地数据库是否可写；本次结果仍保留在当前页面。");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, persistenceMode, trainingResults]);

  useEffect(() => {
    if (!trade) return;
    const pendingTimeframeReplay = pendingTimeframeReplayRef.current;
    const replayToRestore = pendingTimeframeReplay?.tradeId === trade.id &&
      pendingTimeframeReplay.frame === frame
      ? pendingTimeframeReplay
      : null;
    pendingTimeframeReplayRef.current = null;
    const controller = new AbortController();
    const entryMs = timeValue(trade.entryTime) ?? Date.now();
    const intervalMs = FRAME_MS[frame];
    const lastExitMs = trade.exits
      .map((exit) => timeValue(exit.exitTime))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)
      .at(-1);
    const openPositionSnapshotMs = timeValue(
      trade.openPosition?.syncedAt ?? trade.openPosition?.updateTime,
    );
    const startTime = entryMs - intervalMs * EMA_WARMUP_CANDLES;
    const endTime = Math.max(
      entryMs + intervalMs * 420,
      (lastExitMs ?? entryMs) + intervalMs * 50,
      (openPositionSnapshotMs ?? entryMs) + intervalMs * 5,
    );
    const params = new URLSearchParams({
      symbol: normalizeSymbol(trade.symbol),
      interval: frame,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: "1000",
    });
    if (trade.marketDataSource) {
      params.set("market", trade.marketDataSource);
    }

    setPlaying(false);
    setCandles([]);
    setOpenInterest([]);
    setOpenInterestStatus(trade.marketDataSource === "binance-futures" ? "loading" : "idle");
    setOpenInterestNotice("");
    setEntryIndex(0);
    setReplayFrame({ cursor: 0, phase: 0 });
    setLoading(true);
    setSource("正在获取行情");
    setDataNotice("");

    void fetch(`/api/market/klines?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as {
          source?: string;
          candles?: Candle[];
          message?: string;
        };
        if (!response.ok || !Array.isArray(payload.candles) || payload.candles.length < 5) {
          throw new Error(payload.message || "没有取得足够的历史 K 线");
        }
        const cleanCandles = payload.candles
          .filter((candle) =>
            [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite),
          )
          .sort((a, b) => a.time - b.time)
          .filter((candle, index, list) => index === 0 || candle.time !== list[index - 1].time);
        if (cleanCandles.length < 5) throw new Error("行情数据格式异常");
        const nextEntryIndex = locateCandle(cleanCandles, entryMs);
        const nextEntryPhase = getCandlePhaseAtTime(
          cleanCandles[nextEntryIndex],
          entryMs,
          cleanCandles[nextEntryIndex + 1],
        );
        const restoredFrame = replayToRestore
          ? locateReplayFrameAtTime(
              cleanCandles,
              replayToRestore.timeMs,
              nextEntryIndex,
            )
          : { cursor: nextEntryIndex, phase: nextEntryPhase };
        setCandles(cleanCandles);
        setEntryIndex(nextEntryIndex);
        setReplayFrame(restoredFrame);
        setPlaying(Boolean(replayToRestore?.playing));
        setSource(payload.source || "Binance Spot");

        if (trade.marketDataSource === "binance-futures") {
          const openInterestStartIndex = Math.max(
            0,
            nextEntryIndex - CHART_PRE_ENTRY_CANDLES,
          );
          const openInterestParams = new URLSearchParams({
            symbol: normalizeSymbol(trade.symbol),
            period: frame,
            startTime: String(cleanCandles[openInterestStartIndex].time * 1000),
            endTime: String(cleanCandles.at(-1)!.closeTime ?? cleanCandles.at(-1)!.time * 1000),
            limit: "500",
          });
          void fetch(`/api/market/open-interest?${openInterestParams}`, { signal: controller.signal })
            .then(async (response) => {
              const openInterestPayload = (await response.json()) as {
                points?: OpenInterestPoint[];
                message?: string;
              };
              if (!response.ok || !Array.isArray(openInterestPayload.points)) {
                throw new Error(openInterestPayload.message || "没有取得历史 OI");
              }
              const cleanPoints = openInterestPayload.points
                .filter((point) =>
                  [point.time, point.openInterest, point.openInterestValue].every(Number.isFinite),
                )
                .sort((a, b) => a.time - b.time)
                .filter((point, index, list) => index === 0 || point.time !== list[index - 1].time);
              if (!cleanPoints.length) {
                throw new Error("Binance 最近一个月内没有该区间的 OI 数据");
              }
              setOpenInterest(cleanPoints);
              setOpenInterestStatus("available");
              setOpenInterestNotice("");
            })
            .catch((error: unknown) => {
              if (controller.signal.aborted) return;
              setOpenInterest([]);
              setOpenInterestStatus("unavailable");
              setOpenInterestNotice(
                error instanceof Error ? error.message : "历史 OI 暂时不可用",
              );
            });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const demoCandles = generateDemoCandles(trade, frame);
        const nextEntryIndex = locateCandle(demoCandles, entryMs);
        const nextEntryPhase = getCandlePhaseAtTime(
          demoCandles[nextEntryIndex],
          entryMs,
          demoCandles[nextEntryIndex + 1],
        );
        const restoredFrame = replayToRestore
          ? locateReplayFrameAtTime(
              demoCandles,
              replayToRestore.timeMs,
              nextEntryIndex,
            )
          : { cursor: nextEntryIndex, phase: nextEntryPhase };
        setCandles(demoCandles);
        setEntryIndex(nextEntryIndex);
        setReplayFrame(restoredFrame);
        setPlaying(Boolean(replayToRestore?.playing));
        setSource("演示行情");
        setOpenInterest([]);
        setOpenInterestStatus(trade.marketDataSource === "binance-futures" ? "unavailable" : "idle");
        setOpenInterestNotice(
          trade.marketDataSource === "binance-futures" ? "演示行情不附加模拟 OI" : "",
        );
        setDataNotice(
          `${error instanceof Error ? error.message : "网络不可用"}，已切换为演示 K 线；盈亏仍按导入成交计算。`,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  // 自动同步会重建相同的 trade/exits 对象；只在行情请求的语义数据变化时重载，
  // 避免播放中的游标被轮询意外重置到入场点。
  }, [replayMarketDataKey]);

  const replayStartPhase = useMemo(() => {
    const entryMs = timeValue(trade.entryTime);
    if (entryMs === null || !candles[entryIndex]) return 0;
    return getCandlePhaseAtTime(candles[entryIndex], entryMs, candles[entryIndex + 1]);
  }, [candles, entryIndex, trade.entryTime]);

  useEffect(() => {
    if (!playing || !candles.length) return;
    const timer = window.setInterval(() => {
      setReplayFrame((current) => {
        const next = advanceReplayFrame(current, candles.length, 1 / 12);
        return { cursor: next.cursor, phase: next.phase };
      });
    }, 100 / speed);
    return () => window.clearInterval(timer);
  }, [candles.length, playing, speed]);

  useEffect(() => {
    if (
      playing &&
      candles.length > 0 &&
      cursor === candles.length - 1 &&
      candlePhase >= 1
    ) {
      setPlaying(false);
    }
  }, [candlePhase, candles.length, cursor, playing]);

  const step = useCallback(
    (amount: number) => {
      setPlaying(false);
      setReplayFrame((current) => {
        if (candles.length === 0) return current;
        const nextCursor = Math.min(
          Math.max(entryIndex, current.cursor + amount),
          candles.length - 1,
        );
        return {
          cursor: nextCursor,
          phase: nextCursor === entryIndex ? replayStartPhase : 1,
        };
      });
    },
    [candles.length, entryIndex, replayStartPhase],
  );

  const togglePlayback = useCallback(() => {
    if (!playing && cursor === candles.length - 1 && candlePhase >= 1) {
      setReplayFrame({ cursor: entryIndex, phase: replayStartPhase });
      setPlaying(true);
      return;
    }
    setPlaying((value) => !value);
  }, [candlePhase, candles.length, cursor, entryIndex, playing, replayStartPhase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeModule !== "replay") return;
      const element = event.target as HTMLElement | null;
      if (element?.matches("input, textarea, select, button")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowRight") {
        step(1);
      } else if (event.key === "ArrowLeft") {
        step(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeModule, step, togglePlayback]);

  const currentFullCandle = candles[Math.min(cursor, candles.length - 1)];
  const currentCandle = useMemo(
    () => currentFullCandle ? buildPartialCandle(currentFullCandle, candlePhase) : undefined,
    [candlePhase, currentFullCandle],
  );
  const currentReplayTimeMs = currentFullCandle
    ? getReplayTimeMs(currentFullCandle, candlePhase, candles[cursor + 1])
    : null;
  const changeReplayTimeframe = useCallback((nextFrame: TimeFrame) => {
    if (nextFrame === frame) return;
    if (currentReplayTimeMs !== null && Number.isFinite(currentReplayTimeMs)) {
      pendingTimeframeReplayRef.current = {
        tradeId: trade.id,
        frame: nextFrame,
        timeMs: currentReplayTimeMs,
        playing,
      };
    }
    setFrame(nextFrame);
  }, [currentReplayTimeMs, frame, playing, trade.id]);
  const replaySnapshot = useMemo(
    () => buildReplayTradeSnapshot(
      trade,
      currentReplayTimeMs ?? Number.NEGATIVE_INFINITY,
      currentCandle?.close,
    ),
    [currentCandle?.close, currentReplayTimeMs, trade],
  );
  const positionState = useMemo(
    () => buildReplayPositionState(
      trade,
      currentReplayTimeMs ?? Number.NEGATIVE_INFINITY,
    ),
    [currentReplayTimeMs, trade],
  );
  const positionPercent = Math.round(positionState.ratio * 100);
  const positionDisplay = positionState.ratio === 0
    ? "空仓 · 0"
    : positionState.ratio >= 1 - 1e-12
      ? "满仓 · 1/1"
      : `${positionState.label} · ${positionPercent}%`;
  const currentVolume = currentFullCandle
    ? getReplayVolume(currentFullCandle.volume, candlePhase)
    : null;
  const currentOpenInterest = useMemo(
    () => currentReplayTimeMs
      ? getReplayOpenInterestPoints(openInterest, currentReplayTimeMs).at(-1)
      : undefined,
    [currentReplayTimeMs, openInterest],
  );
  const orderFlowAvailable = useMemo(
    () => candles.length > 0 && candles.every((candle) =>
      candle.takerBuyVolume !== undefined &&
      Number.isFinite(candle.takerBuyVolume) &&
      candle.takerBuyVolume >= 0 &&
      candle.takerBuyVolume <= candle.volume,
    ),
    [candles],
  );
  const currentOrderFlow = useMemo(() => {
    if (!orderFlowAvailable || candles.length === 0) {
      return { available: false, delta: [], cvd: [] };
    }
    const chartStartIndex = Math.max(0, entryIndex - CHART_PRE_ENTRY_CANDLES);
    const safeCursor = Math.min(Math.max(cursor, chartStartIndex), candles.length - 1);
    return buildReplayOrderFlowSeries(
      candles.slice(chartStartIndex),
      safeCursor - chartStartIndex,
      candlePhase,
    );
  }, [candlePhase, candles, cursor, entryIndex, orderFlowAvailable]);
  const currentDelta = currentOrderFlow.delta.at(-1)?.value;
  const currentCvd = currentOrderFlow.cvd.at(-1)?.value;
  const currentXin = useMemo(
    () => indicatorVisibility.xinMentorship && currentCandle
      ? buildReplayXinMentorshipSeries(candles, cursor, currentCandle)
      : null,
    [candles, currentCandle, cursor, indicatorVisibility.xinMentorship],
  );
  const currentXinPoint = currentXin?.points.at(-1);
  const indicatorVisibilityKey = INDICATOR_OPTIONS
    .map((item) => `${item.key}:${indicatorVisibility[item.key] ? 1 : 0}`)
    .join(",");
  const currentAverageEntryPrice = replaySnapshot.averageEntryPrice;
  const visibleExits = replaySnapshot.visibleExits;
  const latestVisibleEntry = replaySnapshot.visibleEntries.at(-1);
  const pnl = replaySnapshot.pnl ?? EMPTY_PNL;
  const replayCandleCount = Math.max(candles.length - entryIndex, 1);
  const progress = ((cursor - entryIndex + candlePhase) / replayCandleCount) * 100;
  const replayProgressNodes = useMemo(
    () => buildReplayProgressNodes(trade, candles, entryIndex),
    [candles, entryIndex, trade],
  );
  const pnlTone = pnl.totalPnl > 0 ? "profit" : pnl.totalPnl < 0 ? "loss" : "neutral";
  const priceChange = currentCandle && currentAverageEntryPrice
    ? ((currentCandle.close - currentAverageEntryPrice) / currentAverageEntryPrice) * 100
    : 0;
  const reachedExit = visibleExits.length > 0;
  const latestVisibleExit = visibleExits.at(-1);

  const selectTrade = (id: string) => {
    setSelectedId(id);
    setPlaying(false);
  };

  const selectModule = (module: ActiveModule) => {
    setActiveModule(module);
    if (module !== "replay") setPlaying(false);
  };

  const selectCloseDate = (date: string | null) => {
    setSelectedDate(date);
    const firstTrade = filterTradesByCloseDate(archiveTrades, date)[0];
    if (firstTrade) selectTrade(firstTrade.id);
  };

  const selectTradeProfile = (profileId: string) => {
    const nextProfile = profiles.find((profile) => profile.id === profileId);
    if (!nextProfile) return;
    const nextTrades = filterRecordsByTradeProfile<ReplayTrade>(trades, nextProfile.id);
    const imported = nextTrades.filter((item) => item.id.startsWith("import-"));
    const visible = imported.length > 0
      ? imported
      : nextProfile.id === DEFAULT_TRADE_PROFILE_ID
        ? nextTrades
        : [];
    setActiveProfileId(nextProfile.id);
    setSelectedDate(null);
    setSelectedId(visible[0]?.id ?? DEFAULT_TRADES[0].id);
    setPlaying(false);
    setImportNotice("");
  };

  const closeProfileDialog = () => {
    setProfileDialogOpen(false);
    setProfileNameDraft("");
    setProfileCreateError("");
  };

  const createProfile = () => {
    try {
      const profile = createTradeProfile(profiles, profileNameDraft);
      setProfiles((current) => [...current, profile]);
      closeProfileDialog();
      setActiveProfileId(profile.id);
      setSelectedDate(null);
      setSelectedId(DEFAULT_TRADES[0].id);
      setPlaying(false);
      setImportNotice(`已新建复盘用户“${profile.name}”；后续导入会只保存到该用户。`);
    } catch (error) {
      setProfileCreateError(error instanceof Error ? error.message : "新建用户失败。");
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const extension = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";

      if (extension === "csv" && isBinanceUsdmOrderHistoryCsv(content)) {
        const importedOrders = assignTradeProfile(
          parseBinanceUsdmOrderHistoryCsv(content),
          activeProfile,
          { omitDefault: true },
        ) as BinanceOrderRecord[];
        if (!importedOrders.length) throw new Error("文件中没有可保存的 Binance U 本位订单。");

        const mergedOrders = mergeIntoOrderArchive(importedOrders);
        const reconstruction = reconstructReplayableBinanceOrders(
          filterRecordsByTradeProfile<BinanceOrderRecord>(mergedOrders, activeProfile.id),
        );
        setTrades((current) => mergeImportedReplays(current, reconstruction.trades));
        if (reconstruction.trades[0]) setSelectedId(reconstruction.trades[0].id);

        const warningText = reconstruction.warnings.length
          ? `另有 ${reconstruction.warnings.length} 组订单因缺少完整开平仓方向暂未生成复盘。`
          : "";
        setImportNotice(
          `已将 ${importedOrders.length} 条 Binance U 本位订单保存到“${activeProfile.name}”；该用户生成 ${reconstruction.trades.length} 笔复盘。${warningText}盈亏未含手续费。`,
        );
        return;
      }

      const imported = parseTrades(content, extension).map((importedTrade, index) =>
        sanitizeImportedTrade(
          importedTrade,
          index,
          extension === "json" ? "manual-json" : "manual-csv",
          activeProfile,
        ),
      );
      if (!imported.length) throw new Error("文件中没有可导入的交易。 ");
      setTrades((current) => mergeImportedReplays(current, imported));
      setSelectedId(imported[0].id);
      setImportNotice(`已向“${activeProfile.name}”导入 ${imported.length} 笔交易，文件只在当前设备中处理。`);
    } catch (error) {
      setImportNotice(error instanceof Error ? error.message : "导入失败，请检查文件格式。");
    } finally {
      event.target.value = "";
    }
  };

  const handleConditionOrdersConfirm = (orders: ConfirmedConditionOrder[]) => {
    if (orders.length === 0) return;
    const ordersByTradeId = new Map<string, ConfirmedConditionOrder[]>();
    for (const order of orders) {
      const matched = ordersByTradeId.get(order.matchedTradeId) ?? [];
      matched.push(order);
      ordersByTradeId.set(order.matchedTradeId, matched);
    }

    setTrades((current) => current.map((currentTrade) => {
      const matchedOrders = ordersByTradeId.get(currentTrade.id);
      if (!matchedOrders?.length) return currentTrade;
      return attachConditionOrdersToTrades(
        [currentTrade],
        matchedOrders,
      )[0] as ReplayTrade;
    }));
    setSelectedDate(null);
    setSelectedId(orders[0].matchedTradeId);
    setActiveModule("replay");
    setPlaying(false);
    setImportNotice(
      `已将 ${orders.length} 条 OCR 条件单写入 ${ordersByTradeId.size} 笔复盘；图片未上传，识别结果已保存到当前设备。`,
    );
  };

  const handleBinanceApiSync = async (result: BinanceApiSyncResult) => {
    const selfProfile = profiles.find((profile) => profile.id === DEFAULT_TRADE_PROFILE_ID) ??
      normalizeTradeProfiles([])[0];
    const incomingOrders = mergeBinanceOrderRecords([], assignTradeProfile(
      result.orders,
      selfProfile,
      { omitDefault: true },
    ));
    const mergedOrders = mergeIntoOrderArchive(incomingOrders);
    const accountIds = new Set([
      ...incomingOrders.map((order) => order.userId),
      ...result.openPositions.map((position) => position.userId),
    ]);
    const providerOrders = filterRecordsByTradeProfile<BinanceOrderRecord>(
      mergedOrders.filter((order) => accountIds.has(order.userId)),
      selfProfile.id,
    );
    const reconstruction = reconstructReplayableBinanceOrders(providerOrders, {
      openPositions: assignTradeProfile(
        result.openPositions,
        selfProfile,
        { omitDefault: true },
      ) as BinanceOpenPosition[],
      syncedAt: result.syncedAt,
    });
    const nextTrades = mergeBinanceApiReplays(
      tradesRef.current,
      reconstruction.trades,
      { accountId: result.accountId, profileId: selfProfile.id },
    );
    tradesRef.current = nextTrades;
    setTrades(nextTrades);
    setActiveProfileId(selfProfile.id);
    if (reconstruction.trades[0]) setSelectedId(reconstruction.trades[0].id);
    setSelectedDate(null);
    setActiveModule("replay");
    setPlaying(false);

    const desktopApi = window.cryptoReviewDesktop;
    if (desktopApi) {
      await persistDesktopReplaySnapshot(desktopApi, {
        orders: mergedOrders,
        trades: nextTrades,
      });
    }

    const warningText = reconstruction.warnings.length
      ? `另有 ${reconstruction.warnings.length} 组订单尚未形成完整开平仓。`
      : "";
    setImportNotice(
      `Binance API 已同步 ${result.normalOrderCount} 条基础委托、${result.algoOrderCount} 条条件单、${result.fillCount} 笔成交、${result.fundingFeeCount} 条资金费流水；当前 ${result.openPositionCount} 个未平仓仓位，本地共 ${mergedOrders.length} 条订单，生成 ${reconstruction.trades.length} 笔复盘。手续费与资金费采用 Binance 返回的实际值。${warningText}`,
    );
  };

  const handleOkxApiSync = async (result: OkxApiSyncResult) => {
    const selfProfile = profiles.find((profile) => profile.id === DEFAULT_TRADE_PROFILE_ID) ??
      normalizeTradeProfiles([])[0];
    const incomingOrders = mergeBinanceOrderRecords([], assignTradeProfile(
      result.orders,
      selfProfile,
      { omitDefault: true },
    ));
    const mergedOrders = mergeIntoOrderArchive(incomingOrders);
    const providerOrders = filterRecordsByTradeProfile<BinanceOrderRecord>(
      mergedOrders.filter((order) => order.userId === result.accountId),
      selfProfile.id,
    );
    const reconstruction = reconstructReplayableBinanceOrders(providerOrders, {
      openPositions: assignTradeProfile(
        result.openPositions,
        selfProfile,
        { omitDefault: true },
      ) as BinanceOpenPosition[],
      syncedAt: result.syncedAt,
    });
    const nextTrades = mergeOkxApiReplays(
      tradesRef.current,
      reconstruction.trades,
      { accountId: result.accountId, profileId: selfProfile.id },
    );
    tradesRef.current = nextTrades;
    setTrades(nextTrades);
    setActiveProfileId(selfProfile.id);
    if (reconstruction.trades[0]) setSelectedId(reconstruction.trades[0].id);
    setSelectedDate(null);
    setActiveModule("replay");
    setPlaying(false);

    const desktopApi = window.cryptoReviewDesktop;
    if (desktopApi) {
      await persistDesktopReplaySnapshot(desktopApi, {
        orders: mergedOrders,
        trades: nextTrades,
      });
    }

    const reconstructionWarning = reconstruction.warnings.length
      ? `另有 ${reconstruction.warnings.length} 组订单尚未形成完整开平仓。`
      : "";
    const apiWarnings = result.warnings?.length
      ? `同步提示：${result.warnings
          .map((warning) => typeof warning === "string" ? warning : warning.message)
          .join("；")}。`
      : "";
    setImportNotice(
      `OKX API 已同步 ${result.normalOrderCount} 条基础委托、${result.algoOrderCount} 条条件单、${result.fillCount} 笔成交；当前 ${result.openPositionCount} 个未平仓仓位，本地共 ${mergedOrders.length} 条订单，生成 ${reconstruction.trades.length} 笔复盘。订单来源 OKX，行情来源 Binance U 本位公共行情；手续费采用 OKX 返回的逐笔实际值。${reconstructionWarning}${apiWarnings}`,
    );
  };

  const handleBasicOrdersConfirm = (importedOrders: ParsedBasicOrder[]) => {
    if (importedOrders.length === 0) return;
    const reconciliation = reconcileBasicOrdersWithArchive(
      activeProfileOrders,
      importedOrders,
    );
    const profiledOrders = assignTradeProfile(
      reconciliation.newOrders,
      activeProfile,
      { omitDefault: true },
    ) as BinanceOrderRecord[];
    const mergedOrders = mergeIntoOrderArchive(profiledOrders);
    const reconstruction = reconstructReplayableBinanceOrders(
      filterRecordsByTradeProfile<BinanceOrderRecord>(mergedOrders, activeProfile.id),
    );

    setTrades((current) => mergeImportedReplays(current, reconstruction.trades));
    if (reconstruction.trades[0]) setSelectedId(reconstruction.trades[0].id);
    setSelectedDate(null);
    setActiveModule("replay");
    setPlaying(false);

    const warningText = reconstruction.warnings.length
      ? `另有 ${reconstruction.warnings.length} 组订单尚未形成完整开平仓，已保存但暂不生成复盘。`
      : "";
    const matchedText = reconciliation.matchedExistingCount
      ? `${reconciliation.matchedExistingCount} 条已匹配本机 CSV 官方订单，未重复写入。`
      : "";
    setImportNotice(
      `已向“${activeProfile.name}”写入 ${importedOrders.length} 条基础单，生成 ${reconstruction.trades.length} 笔复盘。${matchedText}${warningText}截图仅有委托时间，成交时刻为近似值。`,
    );
  };

  const handleFollowTradeConfirm = (events: FollowTradeEvent[]) => {
    if (events.length === 0) return;
    const incomingOrders = createFollowTradeOrderRecords(events, {
      profileId: activeProfileId,
      profileName: activeProfile.name,
    }) as BinanceOrderRecord[];
    const mergedOrders = mergeIntoOrderArchive(incomingOrders);
    const profileOrders = filterRecordsByTradeProfile<BinanceOrderRecord>(
      mergedOrders,
      activeProfile.id,
    );
    const reconstruction = reconstructReplayableBinanceOrders(profileOrders);
    setTrades((current) => mergeImportedReplays(current, reconstruction.trades));
    if (reconstruction.trades[0]) setSelectedId(reconstruction.trades[0].id);
    setSelectedDate(null);
    setActiveModule("replay");
    setPlaying(false);
    const pendingText = reconstruction.warnings.length
      ? `另有 ${reconstruction.warnings.length} 组记录缺少完整开平仓，已保存，补齐后会自动生成复盘。`
      : "";
    setImportNotice(
      `已向“${activeProfile.name}”保存 ${events.length} 条跟单成交，生成 ${reconstruction.trades.length} 笔复盘。${pendingText}`,
    );
  };

  const savePublicLeadConfig = useCallback((
    profileId: string,
    config: CopyTradeMonitorConfig | null,
  ) => {
    setProfiles((current) => normalizeTradeProfiles(current.map((profile) => {
      if (profile.id !== profileId) return profile;
      const { copyTradeMonitor: _copyTradeMonitor, ...baseProfile } = profile;
      return config
        ? { ...baseProfile, copyTradeMonitor: config }
        : baseProfile;
    })));
  }, []);

  const handlePublicLeadSync = useCallback(async (
    targetProfile: TradeProfile,
    config: CopyTradeMonitorConfig,
    options: { fullHistory?: boolean; silent?: boolean } = {},
  ) => {
    const syncKey = `${targetProfile.id}\u0000${config.portfolioId}`;
    if (publicLeadSyncingRef.current.has(syncKey)) return;
    publicLeadSyncingRef.current.add(syncKey);
    const attemptedAt = new Date().toISOString();

    try {
      const response = await fetch("/api/copy-trade/lead-portfolio", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolioId: config.portfolioId,
          fullHistory: options.fullHistory === true,
        }),
      });
      const payload = await response.json().catch(() => null) as
        | Record<string, unknown>
        | null;
      if (!response.ok || !payload) {
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : "Binance 公开带单同步失败，请稍后重试。",
        );
      }

      const snapshot = normalizePublicLeadSnapshot(payload, {
        portfolioId: config.portfolioId,
      });
      const smartMoneySource =
        targetProfile.smartMoneySource?.leadPortfolioId === config.portfolioId
          ? targetProfile.smartMoneySource
          : null;
      const sourceOptions = smartMoneySource
        ? {
            source: "smart-money-public" as const,
            sourceIdentity: smartMoneySource.topTraderId,
          }
        : {};
      const incomingOrders = createPublicLeadOrderRecords(snapshot, {
        portfolioId: config.portfolioId,
        profileId: targetProfile.id,
        profileName: targetProfile.name,
        ...sourceOptions,
      }) as BinanceOrderRecord[];
      const openPositions = createPublicLeadOpenPositions(snapshot, {
        portfolioId: config.portfolioId,
        profileId: targetProfile.id,
        profileName: targetProfile.name,
        ...sourceOptions,
      });
      const mergedOrders = mergeIntoOrderArchive(incomingOrders);
      const publicAccountId = smartMoneySource
        ? `smart-money:${smartMoneySource.topTraderId}`
        : `copy-public:${config.portfolioId}`;
      const publicOrders = filterRecordsByTradeProfile<BinanceOrderRecord>(
        mergedOrders,
        targetProfile.id,
      ).filter((order) => order.userId === publicAccountId);
      const reconstruction = reconstructReplayableBinanceOrders(publicOrders, {
        openPositions,
        syncedAt: snapshot.fetchedAt,
      });
      const nextTrades = mergeImportedReplays(
        tradesRef.current,
        reconstruction.trades,
      );
      tradesRef.current = nextTrades;
      setTrades(nextTrades);

      const positionChanges = diffPublicLeadSnapshots(
        config.lastSnapshot,
        snapshot,
      );
      const lastOrderTime = snapshot.orders.reduce(
        (latest, order) => Math.max(latest, order.orderUpdateTime),
        config.lastOrderTime ?? 0,
      );
      savePublicLeadConfig(targetProfile.id, {
        ...config,
        nickname: snapshot.nickname ?? config.nickname,
        lastAttemptAt: snapshot.fetchedAt,
        lastSyncedAt: snapshot.fetchedAt,
        lastOrderTime,
        lastSnapshot: createStoredPublicLeadSnapshot(snapshot),
        lastError: undefined,
      });

      if (!options.silent) {
        if (reconstruction.trades[0]) {
          setSelectedId(reconstruction.trades[0].id);
        }
        setActiveProfileId(targetProfile.id);
        setSelectedDate(null);
        setActiveModule("replay");
        setPlaying(false);
      }

      const desktopApi = window.cryptoReviewDesktop;
      if (desktopApi) {
        await persistDesktopReplaySnapshot(desktopApi, {
          orders: mergedOrders,
          trades: nextTrades,
        });
      }

      if (!options.silent) {
        const changesText = formatPublicLeadPositionChanges(positionChanges);
        const warningCount = reconstruction.warnings.length + snapshot.warnings.length;
        const warningText = warningCount > 0
          ? `另有 ${warningCount} 条提示，请在公开带单设置中核对。`
          : "";
        setImportNotice(
          `已将 ${snapshot.nickname ?? "该交易员"}的 ${incomingOrders.length}/${snapshot.totalOrders} 条${smartMoneySource ? "聪明钱关联公开成交" : "公开成交"}同步到“${targetProfile.name}”，生成 ${reconstruction.trades.length} 笔复盘，当前 ${openPositions.length} 个未平仓仓位。${changesText}${warningText}公开记录不含手续费。`,
        );
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Binance 公开带单同步失败，请稍后重试。";
      savePublicLeadConfig(targetProfile.id, {
        ...config,
        lastAttemptAt: attemptedAt,
        lastError: message,
      });
      if (!options.silent) setImportNotice(message);
      throw error;
    } finally {
      publicLeadSyncingRef.current.delete(syncKey);
    }
  }, [mergeIntoOrderArchive, savePublicLeadConfig]);

  const handleSmartMoneyImport = useCallback(async (sourceUrl: string) => {
    const topTraderId = extractSmartMoneyProfileId(sourceUrl);
    try {
      const response = await fetch("/api/smart-money/profile", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topTraderId }),
      });
      const payload = await response.json().catch(() => null) as
        | Record<string, unknown>
        | null;
      if (!response.ok || !payload) {
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : "Binance 聪明钱主页同步失败，请稍后重试。",
        );
      }

      const snapshot = normalizeSmartMoneyProfileSnapshot(payload, { topTraderId });
      const upserted = upsertSmartMoneyTradeProfile(profiles, snapshot);
      const nextProfiles = normalizeTradeProfiles(upserted.profiles);
      const targetProfile = nextProfiles.find((profile) => profile.id === upserted.profile.id);
      if (!targetProfile?.copyTradeMonitor) {
        throw new Error("聪明钱主页关联档案无效，无法开始同步。");
      }

      setProfiles(nextProfiles);
      setActiveProfileId(targetProfile.id);
      setSelectedDate(null);
      setPlaying(false);
      await handlePublicLeadSync(targetProfile, targetProfile.copyTradeMonitor, {
        fullHistory: true,
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Binance 聪明钱主页同步失败，请稍后重试。";
      setImportNotice(message);
      throw error;
    }
  }, [handlePublicLeadSync, profiles]);

  useEffect(() => {
    if (!hydrated || persistenceMode === "loading") return;
    const timers: number[] = [];
    const now = Date.now();

    for (const profile of profiles) {
      const config = profile.copyTradeMonitor;
      if (!config?.enabled) continue;
      const lastAttempt = Math.max(
        Date.parse(config.lastAttemptAt ?? "") || 0,
        Date.parse(config.lastSyncedAt ?? "") || 0,
      );
      const remaining = config.intervalSeconds * 1000 - (now - lastAttempt);
      const delay = lastAttempt > 0 ? Math.max(1_000, remaining) : 1_000;
      timers.push(window.setTimeout(() => {
        void handlePublicLeadSync(profile, config, {
          silent: true,
          fullHistory: !config.lastSyncedAt,
        }).catch(() => {
          // 错误已写入当前用户的监控配置；按所选间隔重试，不打断正在进行的回放。
        });
      }, delay));
    }

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [handlePublicLeadSync, hydrated, persistenceMode, profiles]);

  return (
    <main className={`replay-app theme-${appTheme}`}>
      <header className="topbar">
        <div className="brand-lockup" aria-label="复盘舱" title="复盘舱">
          <div className="brand-mark"><Activity size={19} strokeWidth={2.2} /></div>
        </div>
        <nav className="topbar-center module-switch" aria-label="主功能切换">
          <button
            type="button"
            className={activeModule === "replay" ? "active" : ""}
            onClick={() => selectModule("replay")}
            aria-pressed={activeModule === "replay"}
            aria-controls="replay-module"
          >
            <Play size={13} />交易回放
          </button>
          <button
            type="button"
            className={activeModule === "performance" ? "active" : ""}
            onClick={() => selectModule("performance")}
            aria-pressed={activeModule === "performance"}
            aria-controls="performance-module"
          >
            <BarChart3 size={13} />交易表现
          </button>
          <button
            type="button"
            className={activeModule === "training" ? "active" : ""}
            onClick={() => selectModule("training")}
            aria-pressed={activeModule === "training"}
            aria-controls="training-module"
          >
            <GraduationCap size={13} />训练模式
          </button>
        </nav>
        <div className="topbar-actions">
          <div className="profile-switcher" aria-label="复盘用户">
            <Users size={14} />
            <span>复盘用户</span>
            <select
              value={activeProfile.id}
              onChange={(event) => selectTradeProfile(event.target.value)}
              aria-label="选择复盘用户"
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setProfileCreateError("");
                setProfileDialogOpen(true);
              }}
              aria-label="新建用户"
              title="新建用户"
            >
              <UserPlus size={14} />
            </button>
          </div>
          <button
            type="button"
            className="chart-theme-toggle"
            onClick={() => setAppTheme((current) => current === "light" ? "dark" : "light")}
            aria-pressed={appTheme === "dark"}
            aria-label={appTheme === "dark" ? "切换日间模式" : "切换夜间模式"}
            title={appTheme === "dark" ? "日间模式" : "夜间模式"}
          >
            {appTheme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          <AppUpdateControl />
          <BinanceApiConnect
            defaultSymbols={binanceApiSymbols}
            onSync={handleBinanceApiSync}
            onOkxSync={handleOkxApiSync}
            disabled={
              !hydrated ||
              persistenceMode === "loading" ||
              activeProfile.id !== DEFAULT_TRADE_PROFILE_ID
            }
          />
          <details className="import-menu">
            <summary className="import-button" aria-label="打开导入菜单" title="导入">
              <FileUp size={15} />
            </summary>
            <div className="import-menu-panel" aria-label="导入方式">
              <span className="import-menu-title">选择导入方式</span>
              <span className="import-menu-target">导入到：{activeProfile.name}</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                onChange={handleImport}
                className="visually-hidden"
                aria-label="选择 Binance U 本位订单历史 CSV 或交易 JSON 文件"
              />
              <button
                type="button"
                className="import-menu-record"
                onClick={() => fileInputRef.current?.click()}
                disabled={!hydrated || persistenceMode === "loading"}
              >
                <FileUp size={14} />
                <span>导入记录</span>
              </button>
              <BasicOrderImport
                onConfirm={handleBasicOrdersConfirm}
                disabled={!hydrated || persistenceMode === "loading"}
              />
              <ConditionOrderImport
                trades={archiveTrades}
                onConfirm={handleConditionOrdersConfirm}
                disabled={!hydrated || persistenceMode === "loading"}
              />
              <FollowTradeImport
                profileName={activeProfile.name}
                onConfirm={handleFollowTradeConfirm}
                disabled={!hydrated || persistenceMode === "loading"}
              />
              <LeadPortfolioMonitor
                profile={activeProfile}
                onSave={(config) => savePublicLeadConfig(activeProfile.id, config)}
                onSync={(config, options) =>
                  handlePublicLeadSync(activeProfile, config, options)}
                disabled={!hydrated || persistenceMode === "loading"}
              />
              <SmartMoneyImport
                onImport={handleSmartMoneyImport}
                disabled={!hydrated || persistenceMode === "loading"}
              />
            </div>
          </details>
        </div>
      </header>

      <dialog
        ref={profileDialogRef}
        className="profile-create-dialog"
        aria-labelledby="profile-create-title"
        onCancel={(event) => {
          event.preventDefault();
          closeProfileDialog();
        }}
      >
        <div>
          <span className="eyebrow">TRADE PROFILE</span>
          <h2 id="profile-create-title">新建用户</h2>
          <p>每个用户的订单、复盘列表和交易表现都会独立显示。</p>
          <label>
            <span>用户名称</span>
            <input
              autoFocus
              maxLength={20}
              value={profileNameDraft}
              onChange={(event) => {
                setProfileNameDraft(event.target.value);
                setProfileCreateError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  createProfile();
                }
              }}
              placeholder="例如：小洪"
            />
          </label>
          {profileCreateError && <em>{profileCreateError}</em>}
          <footer>
            <button type="button" onClick={closeProfileDialog}>取消</button>
            <button type="button" className="primary" onClick={createProfile}>
              创建并切换
            </button>
          </footer>
        </div>
      </dialog>

      {activeModule === "replay" ? (
      <div id="replay-module" className="workspace" aria-label="交易回放模块">
        {archiveTrades.length === 0 ? (
          <section className="profile-empty-workspace">
            <Users size={30} />
            <span className="eyebrow">独立交易档案</span>
            <h1>{activeProfile.name}还没有复盘记录</h1>
            <p>
              打开右上角“导入”，可识别跟单记录截图、基础单截图，
              或导入 CSV/JSON；数据只会写入当前用户。
            </p>
            {importNotice && (
              <div className="status-banner" role="status" aria-live="polite">
                <Sparkles size={15} /> {importNotice}
                <button onClick={() => setImportNotice("")} aria-label="关闭导入提示">×</button>
              </div>
            )}
          </section>
        ) : (
        <>
        <aside className="trade-sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">交易档案</span>
              <h2>{activeProfile.name}的复盘</h2>
            </div>
            <span className="count-badge">{filteredTrades.length}</span>
          </div>
          <div className="date-filter" role="group" aria-label="按最终平仓日期筛选">
            <button
              className={`date-filter-button ${selectedDate === null ? "active" : ""}`}
              onClick={() => selectCloseDate(null)}
              aria-pressed={selectedDate === null}
            >
              <span className="date-filter-label">全部</span>
              <span className="date-filter-count">{archiveTrades.length}</span>
            </button>
            {closeDateGroups.map((group) => (
              <button
                key={group.date}
                className={`date-filter-button ${selectedDate === group.date ? "active" : ""}`}
                onClick={() => selectCloseDate(group.date)}
                aria-pressed={selectedDate === group.date}
              >
                <span className="date-filter-label">{group.date}</span>
                <span className="date-filter-count">{group.count}</span>
              </button>
            ))}
          </div>
          <div className="trade-list" role="list" aria-label="交易列表">
            {filteredTrades.map((item) => {
              const finalPnl = finalTradePnl(item);
              const positive = finalPnl.totalPnl >= 0;
              const sourceDisplay = getReplaySourceDisplay(item);
              return (
                <button
                  key={item.id}
                  className={`trade-list-item ${item.id === trade.id ? "active" : ""}`}
                  onClick={() => selectTrade(item.id)}
                  role="listitem"
                  aria-current={item.id === trade.id ? "true" : undefined}
                >
                  <div className="trade-list-top">
                    <span className="asset-avatar">{normalizeSymbol(item.symbol).slice(0, 1)}</span>
                    <span className="trade-list-symbol">{displaySymbol(item.symbol)}</span>
                    <span
                      className="trade-source-badge"
                      title={sourceDisplay.title}
                      aria-label={sourceDisplay.title}
                    >
                      {sourceDisplay.shortLabel}
                    </span>
                    <span className={`side-badge ${item.side}`}>
                      {item.side === "long" ? "多" : "空"}
                    </span>
                    <ChevronRight size={15} className="chevron" />
                  </div>
                  <div className="trade-list-meta">
                    <span>
                      {item.openPosition
                        ? `未平仓 · 入场 ${formatDateTime(item.entryTime)}`
                        : formatDateTime(getTradeCloseTime(item))}
                    </span>
                    <strong className={positive ? "tone-profit" : "tone-loss"}>
                      {formatMoney(finalPnl.totalPnl, true)}
                    </strong>
                  </div>
                  <div className="trade-mini-track">
                    <span style={{ width: `${Math.min(Math.abs(finalPnl.returnRatePercent) * 4 + 18, 100)}%` }} />
                  </div>
                </button>
              );
            })}
            {filteredTrades.length === 0 && (
              <div className="date-filter-empty">该日期暂无复盘</div>
            )}
          </div>
          <div className="import-hint">
            <FileUp size={17} />
            <div>
              <strong>Binance U 本位订单历史</strong>
              <span>导入 CSV 自动重建并保存在本机</span>
            </div>
          </div>
        </aside>

        <section className="replay-stage">
          <div className="trade-hero">
            <div className="trade-identity">
              <span className="hero-asset">{normalizeSymbol(trade.symbol).slice(0, 1)}</span>
              <div>
                <div className="hero-title-row">
                  <h1>{displaySymbol(trade.symbol)}</h1>
                  <span className={`position-chip ${trade.side}`}>
                    {trade.side === "long" ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                    {trade.side === "long" ? "LONG" : "SHORT"}
                  </span>
                </div>
                <p>{trade.strategy} · {formatDateTime(trade.entryTime)} 入场</p>
              </div>
            </div>
            <div className="hero-stats">
              <div>
                <span>当前成本</span>
                <strong>{currentAverageEntryPrice ? formatPrice(currentAverageEntryPrice) : "—"}</strong>
              </div>
              <div><span>当前回放价</span><strong>{currentCandle ? formatPrice(currentCandle.close) : "—"}</strong></div>
              <div><span>价格变化</span><strong className={priceChange >= 0 ? "tone-profit" : "tone-loss"}>{formatPercent(priceChange, true)}</strong></div>
            </div>
          </div>

          {importNotice && (
            <div className="status-banner" role="status" aria-live="polite">
              <Sparkles size={15} /> {importNotice}
              <button onClick={() => setImportNotice("")} aria-label="关闭导入提示">×</button>
            </div>
          )}
          {dataNotice && (
            <div className="status-banner warning" role="status">
              <ShieldAlert size={15} /> {dataNotice}
            </div>
          )}

          <section className="chart-card" aria-label="交易回放图表">
            <div className="chart-toolbar">
              <div className={`replay-toolbar-pnl ${pnlTone}`}>
                <span>{trade.feesKnown === false
                  ? "当前盈亏（未含手续费）"
                  : trade.fundingFeesKnown === false
                    ? "当前盈亏（资金费待核对）"
                    : "当前盈亏"}</span>
                <strong>{formatMoney(pnl.totalPnl, true)}</strong>
                <em>{formatPercent(pnl.returnRatePercent, true)}</em>
              </div>
              <div className="chart-toolbar-actions">
                <ReplayVideoExport
                  trade={trade}
                  frame={frame}
                  candles={candles}
                  openInterest={openInterest}
                  source={source}
                  entryIndex={entryIndex}
                  indicatorVisibility={indicatorVisibility}
                  volumeColoringConfig={volumeColoringConfig}
                  disabled={loading || candles.length === 0}
                  onExportStart={() => setPlaying(false)}
                />
                <details className="indicator-picker">
                  <summary>
                    <SlidersHorizontal size={13} />
                    指标显示
                  </summary>
                  <div className="indicator-picker-menu" role="group" aria-label="选择图表指标">
                    {INDICATOR_OPTIONS.map((item) => {
                      const unavailable = item.key === "openInterest"
                        ? openInterest.length === 0
                        : (item.key === "delta" || item.key === "cvd") && !orderFlowAvailable;
                      return (
                        <label key={item.key} className={unavailable ? "disabled" : ""}>
                          <input
                            type="checkbox"
                            checked={indicatorVisibility[item.key]}
                            disabled={unavailable}
                            onChange={(event) => setIndicatorVisibility((current) => ({
                              ...current,
                              [item.key]: event.target.checked,
                            }))}
                          />
                          <span>{item.label}</span>
                          {unavailable && <small>无数据</small>}
                        </label>
                      );
                    })}
                    <div
                      className={`indicator-picker-params ${
                        indicatorVisibility.volumeColoring ? "" : "disabled"
                      }`}
                      aria-label="成交量染色参数"
                    >
                      <span className="indicator-picker-params-title">
                        染色参数
                        <small>&gt;3× 红/绿 · ≤0.25× 黄</small>
                      </span>
                      <label>
                        <span>RVOL 周期</span>
                        <input
                          type="number"
                          min={1}
                          max={VOLUME_COLORING_MAX_PERIOD}
                          step={1}
                          value={volumeColoringConfig.rvolPeriod}
                          disabled={!indicatorVisibility.volumeColoring}
                          onChange={(event) => {
                            const value = event.currentTarget.valueAsNumber;
                            if (!Number.isFinite(value)) return;
                            setVolumeColoringConfig((current) => ({
                              ...current,
                              rvolPeriod: Math.min(
                                VOLUME_COLORING_MAX_PERIOD,
                                Math.max(1, Math.trunc(value)),
                              ),
                            }));
                          }}
                        />
                      </label>
                      <label>
                        <span>最高/最低回看</span>
                        <input
                          type="number"
                          min={1}
                          max={VOLUME_COLORING_MAX_PERIOD}
                          step={1}
                          value={volumeColoringConfig.lookback}
                          disabled={!indicatorVisibility.volumeColoring}
                          onChange={(event) => {
                            const value = event.currentTarget.valueAsNumber;
                            if (!Number.isFinite(value)) return;
                            setVolumeColoringConfig((current) => ({
                              ...current,
                              lookback: Math.min(
                                VOLUME_COLORING_MAX_PERIOD,
                                Math.max(1, Math.trunc(value)),
                              ),
                            }));
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </details>
                <div className="timeframe-tabs" aria-label="时间框架">
                  {(Object.keys(FRAME_LABELS) as TimeFrame[]).map((item) => (
                    <button
                      key={item}
                      className={frame === item ? "active" : ""}
                      onClick={() => changeReplayTimeframe(item)}
                      aria-pressed={frame === item}
                    >
                      {FRAME_LABELS[item]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="ohlc-strip" aria-live="polite">
              <span>{currentReplayTimeMs ? formatDateTime(currentReplayTimeMs) : "—"}</span>
              <span>开 <b>{currentCandle ? formatPrice(currentCandle.open) : "—"}</b></span>
              <span>高 <b className="tone-profit">{currentCandle ? formatPrice(currentCandle.high) : "—"}</b></span>
              <span>低 <b className="tone-loss">{currentCandle ? formatPrice(currentCandle.low) : "—"}</b></span>
              <span>收 <b>{currentCandle ? formatPrice(currentCandle.close) : "—"}</b></span>
              {indicatorVisibility.volume && (
                <span>成交量 <b>{currentVolume === null ? "—" : formatCompactNumber(currentVolume)}</b></span>
              )}
              {indicatorVisibility.openInterest && trade.marketDataSource === "binance-futures" && (
                <span title={
                  openInterestStatus === "loading"
                    ? "正在获取 Binance Futures 历史 OI"
                    : openInterestStatus === "unavailable"
                      ? openInterestNotice
                      : "Binance Futures 历史总持仓量"
                }>
                  OI <b className="indicator-oi-value">
                    {currentOpenInterest
                      ? formatCompactNumber(currentOpenInterest.openInterest)
                      : openInterestStatus === "loading"
                        ? "载入中"
                        : openInterestStatus === "unavailable"
                          ? "无数据"
                          : "—"}
                  </b>
                </span>
              )}
              {indicatorVisibility.delta && orderFlowAvailable && (
                <span title="Binance 只提供完整 K 线主动买量；形成中的当前 K 线暂不计入">
                  Delta <b className={currentDelta !== undefined && currentDelta < 0 ? "tone-loss" : "tone-profit"}>
                    {currentDelta === undefined ? "—" : formatCompactNumber(currentDelta)}
                  </b>
                </span>
              )}
              {indicatorVisibility.cvd && orderFlowAvailable && (
                <span title="从当前图表可见区间起点累计已完成 K 线 Delta">
                  CVD <b className="indicator-cvd-value">
                    {currentCvd === undefined ? "—" : formatCompactNumber(currentCvd)}
                  </b>
                </span>
              )}
              {indicatorVisibility.xinMentorship && currentXin && (
                <span title={[
                  `RSI ${currentXinPoint?.rsi?.toFixed(1) ?? "—"}`,
                  `MFI ${currentXinPoint?.mfi?.toFixed(1) ?? "—"}`,
                  `Momentum ${currentXinPoint?.momentum?.toFixed(2) ?? "—"}`,
                  `Accel ${currentXinPoint?.acceleration?.toFixed(2) ?? "—"}`,
                ].join(" · ")}>
                  XIN <b className={
                    currentXin.status.includes("overbought") ||
                    currentXin.status === "bearish"
                      ? "tone-loss"
                      : "tone-profit"
                  }>
                    {XIN_STATUS_LABELS[currentXin.status]} · WT1
                    {" "}{currentXinPoint?.wt1?.toFixed(1) ?? "—"}
                  </b>
                </span>
              )}
              <span title="基于当前 OHLC 合成单根蜡烛的运行路径，不代表真实逐笔成交顺序">
                本根 <b>{Math.round(candlePhase * 100)}%</b>
              </span>
            </div>

            <div
              className={`position-ratio-strip ${trade.side}`}
              title="相对截至当前的最大持仓"
            >
              <span className="position-ratio-copy">
                <strong>当前仓位</strong>
                <small>相对截至当前的最大持仓</small>
              </span>
              <div
                className="position-ratio-track"
                role="progressbar"
                aria-label="当前仓位比例（相对截至当前的最大持仓）"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={positionPercent}
                aria-valuetext={positionDisplay}
              >
                {positionState.segments.map((segment, index) => (
                  <span
                    key={`${segment.id}-${index}`}
                    className={`position-ratio-segment ${
                      segment.isAddition ? "addition" : "base"
                    } position-color-${segment.colorIndex % 4}`}
                    style={{ width: `${segment.ratio * 100}%` }}
                    title={`${segment.isAddition ? "加仓" : "基础仓"} · 剩余 ${segment.remainingQuantity.toLocaleString("zh-CN")}`}
                    aria-hidden="true"
                  />
                ))}
              </div>
              <strong className="position-ratio-value">{positionDisplay}</strong>
            </div>

            <div className="chart-area">
              <CandleReplayChart
                key={`${trade.id}:${frame}:${indicatorVisibilityKey}:${openInterest.length > 0 ? "oi" : "no-oi"}:${orderFlowAvailable ? "flow" : "no-flow"}`}
                candles={candles}
                openInterest={openInterest}
                cursor={cursor}
                candlePhase={candlePhase}
                currentCandle={currentCandle}
                entryIndex={entryIndex}
                trade={trade}
                indicatorVisibility={indicatorVisibility}
                volumeColoringConfig={volumeColoringConfig}
                orderFlowAvailable={orderFlowAvailable}
              />
              {loading && <div className="chart-loading"><span />正在载入历史行情</div>}
              <div className="chart-legend">
                <span><i className="legend-cost" />成本</span>
                {indicatorVisibility.ema21 && <span><i className="legend-ema21" />EMA21</span>}
                {indicatorVisibility.ema200 && <span><i className="legend-ema200" />EMA200</span>}
                {indicatorVisibility.xinMentorship && <span><i className="legend-xin" />XIN Mentorship</span>}
                <span><i className="legend-entry" />入场</span>
                <span><i className="legend-exit" />离场</span>
                <span><i className="legend-tp" />止盈</span>
                <span><i className="legend-sl" />止损</span>
                {indicatorVisibility.volume && <span><i className="legend-volume" />成交量</span>}
                {indicatorVisibility.openInterest && openInterest.length > 0 && <span><i className="legend-oi" />OI</span>}
                {indicatorVisibility.delta && orderFlowAvailable && <span><i className="legend-delta" />Delta</span>}
                {indicatorVisibility.cvd && orderFlowAvailable && <span><i className="legend-cvd" />CVD</span>}
              </div>
            </div>

            <div className="replay-controls">
              <button
                className="icon-control"
                onClick={() => {
                  setPlaying(false);
                  setReplayFrame({ cursor: entryIndex, phase: replayStartPhase });
                }}
                aria-label="回到入场点"
                title="回到入场点"
              >
                <RotateCcw size={17} />
              </button>
              <button className="icon-control" onClick={() => step(-1)} aria-label="后退一根 K 线">
                <SkipBack size={17} />
              </button>
              <button
                className="play-control"
                onClick={togglePlayback}
                aria-label={playing ? "暂停回放" : "开始回放"}
              >
                {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
                {playing ? "暂停" : "回放"}
              </button>
              <button className="icon-control" onClick={() => step(1)} aria-label="前进一根 K 线">
                <SkipForward size={17} />
              </button>
              <div className="replay-progress">
                <div className="replay-progress-track">
                  <input
                    type="range"
                    min={entryIndex}
                    max={Math.max(entryIndex, candles.length - 1)}
                    value={Math.min(cursor, Math.max(entryIndex, candles.length - 1))}
                    onChange={(event) => {
                      setPlaying(false);
                      const nextCursor = Number(event.target.value);
                      setReplayFrame({
                        cursor: nextCursor,
                        phase: nextCursor === entryIndex ? replayStartPhase : 1,
                      });
                    }}
                    aria-label="回放进度"
                    style={{ "--progress": `${Math.max(0, Math.min(progress, 100))}%` } as CSSProperties}
                  />
                  <div className="replay-progress-events" aria-label="交易操作节点">
                    {replayProgressNodes.map((node) => {
                      const tooltipLines = node.actions.map(formatReplayProgressAction);
                      const tooltipText = `${formatReplayEventTime(node.timeMs)}，${tooltipLines.join("；")}`;
                      const edgeClass = node.positionPercent < 8
                        ? "edge-start"
                        : node.positionPercent > 92
                          ? "edge-end"
                          : "";
                      return (
                        <span
                          key={node.id}
                          className={`replay-progress-event tone-${node.tone} ${edgeClass}`}
                          style={{ left: `${node.positionPercent}%` }}
                          tabIndex={0}
                          aria-label={tooltipText}
                        >
                          <span className="replay-progress-tooltip" role="tooltip">
                            <strong>{formatReplayEventTime(node.timeMs)}</strong>
                            {tooltipLines.map((line, index) => (
                              <span key={`${node.id}-line-${index}`}>{line}</span>
                            ))}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </div>
                <div className="replay-progress-meta">
                  <span>{Math.max(0, cursor - entryIndex + 1)} 根</span>
                  <span>本根 {Math.round(candlePhase * 100)}% · 总进度 {Math.round(Math.max(0, Math.min(progress, 100)))}%</span>
                </div>
              </div>
              <button
                className="speed-control"
                onClick={() => setSpeed((value) => (value === 1 ? 2 : value === 2 ? 4 : 1))}
                aria-label={`当前 ${speed} 倍速，点击切换`}
              >
                {speed}×
              </button>
            </div>
          </section>

          <section className="execution-card">
            <div className="section-heading-inline">
              <div><CircleDot size={16} /><strong>执行时间线</strong></div>
              <span>仅展示已到达的成交事件</span>
            </div>
            <div className="execution-grid">
              <div className="execution-event entry-event">
                <span className="event-icon"><ArrowUpRight size={15} /></span>
                <div>
                  <span>{replaySnapshot.visibleEntries.length > 1 ? "加仓后成本" : "入场成本"}</span>
                  <strong>{currentAverageEntryPrice ? formatPrice(currentAverageEntryPrice) : "未来数据已隐藏"}</strong>
                  <small>{latestVisibleEntry
                    ? formatDateTime(latestVisibleEntry.entryTime)
                    : "继续播放以查看入场"}</small>
                </div>
              </div>
              <div className="execution-connector" />
              <div className={`execution-event ${reachedExit ? "exit-event" : "pending-event"}`}>
                <span className="event-icon">{reachedExit ? <Target size={15} /> : <Gauge size={15} />}</span>
                <div>
                  <span>{reachedExit ? (trade.exitLabel ?? "离场成交") : "等待回放"}</span>
                  <strong>{latestVisibleExit ? formatPrice(latestVisibleExit.exitPrice) : "未来数据已隐藏"}</strong>
                  <small>{latestVisibleExit ? formatDateTime(latestVisibleExit.exitTime) : "继续播放以查看后续"}</small>
                </div>
              </div>
            </div>
          </section>
        </section>

        </>
        )}
      </div>
      ) : activeModule === "performance" ? (
        <section id="performance-module" className="performance-workspace" aria-label="交易表现模块">
          <div className="performance-profile-context">
            <Users size={14} />
            <span>当前用户</span>
            <strong>{activeProfile.name}</strong>
          </div>
          {importNotice && (
            <div className="status-banner performance-status" role="status" aria-live="polite">
              <Sparkles size={15} /> {importNotice}
              <button onClick={() => setImportNotice("")} aria-label="关闭导入提示">×</button>
            </div>
          )}
          <PerformanceOverview trades={archiveTrades} selectedDate={null} />
        </section>
      ) : null}

      <div hidden={activeModule !== "training"}>
        <TrainingMode
          trainingResults={trainingResults}
          onResultsChange={setTrainingResults}
        />
      </div>

      <footer className="app-footer">
        <span>CryptoReview · 仅用于交易复盘，不构成投资建议</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
      </footer>
    </main>
  );
}
