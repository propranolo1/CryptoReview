"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  ChevronRight,
  CircleDot,
  FileUp,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  SkipBack,
  SkipForward,
  Sparkles,
  Target,
  WalletCards,
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
  type TradeExit,
  type TradePnlResult,
} from "@/lib/trade.mjs";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
};

type ReplayTrade = NormalizedTrade & {
  id: string;
  title: string;
  strategy: string;
  notes: string;
};

type TimeFrame = "5m" | "15m" | "1h" | "4h" | "1d";

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

const DEFAULT_TRADES: ReplayTrade[] = [
  {
    id: "btc-breakout",
    title: "区间突破",
    strategy: "突破回踩",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 0.18,
    entryPrice: 94_250,
    entryTime: "2025-05-06T08:00:00.000Z",
    stopLoss: 91_700,
    takeProfit: 101_200,
    exitPrice: 101_450,
    exitTime: "2025-05-09T01:00:00.000Z",
    fee: 13.8,
    exits: [
      {
        quantity: 0.18,
        exitPrice: 101_450,
        exitTime: "2025-05-09T01:00:00.000Z",
        fee: 7.4,
      },
    ],
    notes: "突破后回踩没有跌回区间，执行符合计划。重点复盘入场后第一次快速回落时的情绪。",
  },
  {
    id: "sol-reversal",
    title: "冲高回落",
    strategy: "反转确认",
    symbol: "SOLUSDT",
    side: "short",
    quantity: 24,
    entryPrice: 180.2,
    entryTime: "2025-05-23T12:00:00.000Z",
    stopLoss: 188.6,
    takeProfit: 164.8,
    exitPrice: 168.4,
    exitTime: "2025-05-25T20:00:00.000Z",
    fee: 8.5,
    exits: [
      {
        quantity: 24,
        exitPrice: 168.4,
        exitTime: "2025-05-25T20:00:00.000Z",
        fee: 4.2,
      },
    ],
    notes: "反转结构成立后入场，止损放在前高上方。可以继续观察是否存在更好的分批止盈位置。",
  },
  {
    id: "eth-pullback",
    title: "趋势回踩",
    strategy: "顺势交易",
    symbol: "ETHUSDT",
    side: "long",
    quantity: 3.2,
    entryPrice: 2_560,
    entryTime: "2025-05-12T06:00:00.000Z",
    stopLoss: 2_455,
    takeProfit: 2_720,
    exitPrice: 2_698,
    exitTime: "2025-05-14T10:00:00.000Z",
    fee: 11.3,
    exits: [
      {
        quantity: 3.2,
        exitPrice: 2_698,
        exitTime: "2025-05-14T10:00:00.000Z",
        fee: 5.7,
      },
    ],
    notes: "方向判断正确，但离止盈位只差少量空间时主动离场。复盘是否属于计划内退出。",
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

function timeValue(iso: string | null | undefined) {
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
  const entryIndex = 80;
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

function sanitizeImportedTrade(trade: NormalizedTrade, index: number): ReplayTrade {
  if (!trade.entryTime || !timeValue(trade.entryTime)) {
    throw new Error(`第 ${index + 1} 笔交易缺少有效的入场时间。`);
  }
  const symbol = normalizeSymbol(trade.symbol);
  return {
    ...trade,
    symbol,
    id: `import-${Date.now()}-${index}`,
    title: "导入交易",
    strategy: "待归类",
    notes: "",
  };
}

function replayPnl(trade: ReplayTrade, candle: Candle | undefined) {
  if (!candle) return EMPTY_PNL;
  const currentMs = candle.time * 1000;
  const visibleExits = trade.exits.filter((exit) => {
    const exitMs = timeValue(exit.exitTime);
    return exitMs !== null && exitMs <= currentMs;
  });
  try {
    return calculateTradePnl(
      {
        ...trade,
        exits: visibleExits,
        exitPrice: null,
        exitTime: null,
      },
      candle.close,
    );
  } catch {
    return EMPTY_PNL;
  }
}

function finalTradePnl(trade: ReplayTrade) {
  const fallbackPrice = trade.exits.at(-1)?.exitPrice ?? trade.entryPrice;
  try {
    return calculateTradePnl(trade, fallbackPrice);
  } catch {
    return EMPTY_PNL;
  }
}

function CandleReplayChart({
  candles,
  cursor,
  entryIndex,
  trade,
}: {
  candles: Candle[];
  cursor: number;
  entryIndex: number;
  trade: ReplayTrade;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const renderedCursorRef = useRef(-1);
  const dataKeyRef = useRef("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let chart: IChartApi | null = null;

    void (async () => {
      const library = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;

      chart = library.createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: library.ColorType.Solid, color: "#11151a" },
          textColor: "#89919b",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(116, 126, 137, 0.08)" },
          horzLines: { color: "rgba(116, 126, 137, 0.08)" },
        },
        crosshair: {
          mode: library.CrosshairMode.Normal,
          vertLine: { color: "rgba(226, 232, 240, 0.28)", labelBackgroundColor: "#2d343c" },
          horzLine: { color: "rgba(226, 232, 240, 0.22)", labelBackgroundColor: "#2d343c" },
        },
        rightPriceScale: {
          borderColor: "rgba(116, 126, 137, 0.16)",
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          borderColor: "rgba(116, 126, 137, 0.16)",
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
        upColor: "#30c487",
        downColor: "#ef6572",
        borderVisible: false,
        wickUpColor: "#30c487",
        wickDownColor: "#ef6572",
        priceLineVisible: false,
        lastValueVisible: true,
      });
      const markers = library.createSeriesMarkers(series, [], { autoScale: true });

      chartRef.current = chart;
      seriesRef.current = series;
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
      markersRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!ready || !series) return;

    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];

    if (trade.takeProfit) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: trade.takeProfit,
          color: "rgba(48, 196, 135, 0.88)",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "止盈",
        }),
      );
    }
    if (trade.stopLoss) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: trade.stopLoss,
          color: "rgba(239, 101, 114, 0.88)",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "止损",
        }),
      );
    }
  }, [ready, trade.id, trade.stopLoss, trade.takeProfit]);

  useEffect(() => {
    const series = seriesRef.current;
    const markerApi = markersRef.current;
    const chart = chartRef.current;
    if (!ready || !series || !markerApi || !chart || !candles.length) return;

    const safeCursor = Math.min(Math.max(cursor, 0), candles.length - 1);
    const dataKey = `${candles[0].time}:${candles.length}:${trade.id}`;
    const toChartBar = (candle: Candle): CandlestickData<UTCTimestamp> => ({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });
    const nextBar = toChartBar(candles[safeCursor]);
    const canAppend =
      dataKeyRef.current === dataKey && renderedCursorRef.current + 1 === safeCursor;

    if (canAppend) {
      series.update(nextBar);
    } else {
      series.setData(candles.slice(0, safeCursor + 1).map(toChartBar));
    }
    dataKeyRef.current = dataKey;
    renderedCursorRef.current = safeCursor;

    const markers: SeriesMarker<Time>[] = [];
    if (safeCursor >= entryIndex && candles[entryIndex]) {
      markers.push({
        id: `entry-${trade.id}`,
        time: candles[entryIndex].time as UTCTimestamp,
        position: "atPriceMiddle",
        price: trade.entryPrice,
        color: trade.side === "long" ? "#f4b860" : "#b99aff",
        shape: trade.side === "long" ? "arrowUp" : "arrowDown",
        text: `${trade.side === "long" ? "买入" : "卖空"} ${formatPrice(trade.entryPrice)}`,
        size: 1.5,
      });
    }

    trade.exits.forEach((exit, index) => {
      const exitMs = timeValue(exit.exitTime);
      if (!exitMs) return;
      const exitIndex = locateCandle(candles, exitMs);
      if (exitIndex > safeCursor) return;
      markers.push({
        id: `exit-${trade.id}-${index}`,
        time: candles[exitIndex].time as UTCTimestamp,
        position: "atPriceMiddle",
        price: exit.exitPrice,
        color: "#62a8ff",
        shape: trade.side === "long" ? "arrowDown" : "arrowUp",
        text: `${trade.side === "long" ? "卖出" : "买回"} ${formatPrice(exit.exitPrice)}`,
        size: 1.5,
      });
    });

    markers.sort((a, b) => Number(a.time) - Number(b.time));
    markerApi.setMarkers(markers);

    if (safeCursor <= entryIndex || renderedCursorRef.current < 0) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().scrollToRealTime();
    }
  }, [candles, cursor, entryIndex, ready, trade]);

  return (
    <div className="chart-canvas-wrap">
      <div ref={containerRef} className="chart-canvas" aria-hidden="true" />
      {!ready && <div className="chart-placeholder">正在准备图表…</div>}
    </div>
  );
}

function MetricRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="metric-row">
      <span>{label}</span>
      <strong className={tone ? `tone-${tone}` : undefined}>{value}</strong>
    </div>
  );
}

export function TradeReplay() {
  const [trades, setTrades] = useState<ReplayTrade[]>(DEFAULT_TRADES);
  const [selectedId, setSelectedId] = useState(DEFAULT_TRADES[0].id);
  const [frame, setFrame] = useState<TimeFrame>("1h");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [cursor, setCursor] = useState(0);
  const [entryIndex, setEntryIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("正在获取行情");
  const [dataNotice, setDataNotice] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trade = trades.find((item) => item.id === selectedId) ?? trades[0];

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("cryptoreview-trades-v1");
      if (saved) {
        const parsed = JSON.parse(saved) as ReplayTrade[];
        if (Array.isArray(parsed) && parsed.length) {
          setTrades(parsed);
          setSelectedId(parsed[0].id);
        }
      }
    } catch {
      // 本地数据损坏时使用内置示例，不阻断复盘。
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem("cryptoreview-trades-v1", JSON.stringify(trades));
  }, [hydrated, trades]);

  useEffect(() => {
    if (!trade) return;
    const controller = new AbortController();
    const entryMs = timeValue(trade.entryTime) ?? Date.now();
    const intervalMs = FRAME_MS[frame];
    const lastExitMs = trade.exits
      .map((exit) => timeValue(exit.exitTime))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)
      .at(-1);
    const startTime = entryMs - intervalMs * 80;
    const endTime = Math.max(entryMs + intervalMs * 420, (lastExitMs ?? entryMs) + intervalMs * 50);
    const params = new URLSearchParams({
      symbol: normalizeSymbol(trade.symbol),
      interval: frame,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: "1000",
    });

    setPlaying(false);
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
        setCandles(cleanCandles);
        setEntryIndex(nextEntryIndex);
        setCursor(nextEntryIndex);
        setSource(payload.source || "Binance Spot");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const demoCandles = generateDemoCandles(trade, frame);
        const nextEntryIndex = locateCandle(demoCandles, entryMs);
        setCandles(demoCandles);
        setEntryIndex(nextEntryIndex);
        setCursor(nextEntryIndex);
        setSource("演示行情");
        setDataNotice(
          `${error instanceof Error ? error.message : "网络不可用"}，已切换为演示 K 线；盈亏仍按导入成交计算。`,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [frame, trade.entryTime, trade.exits, trade.id, trade.symbol]);

  useEffect(() => {
    if (!playing || !candles.length) return;
    const timer = window.setInterval(() => {
      setCursor((current) => {
        if (current >= candles.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, Math.max(90, 720 / speed));
    return () => window.clearInterval(timer);
  }, [candles.length, playing, speed]);

  const step = useCallback(
    (amount: number) => {
      setPlaying(false);
      setCursor((current) => Math.min(Math.max(entryIndex, current + amount), candles.length - 1));
    },
    [candles.length, entryIndex],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.matches("input, textarea, select, button")) return;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (event.key === "ArrowRight") {
        step(1);
      } else if (event.key === "ArrowLeft") {
        step(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step]);

  const currentCandle = candles[Math.min(cursor, candles.length - 1)];
  const pnl = useMemo(() => replayPnl(trade, currentCandle), [currentCandle, trade]);
  const progress = candles.length > entryIndex + 1
    ? ((cursor - entryIndex) / (candles.length - 1 - entryIndex)) * 100
    : 0;
  const pnlTone = pnl.totalPnl > 0 ? "profit" : pnl.totalPnl < 0 ? "loss" : "neutral";
  const priceChange = currentCandle
    ? ((currentCandle.close - trade.entryPrice) / trade.entryPrice) * 100
    : 0;
  const risk = trade.stopLoss
    ? Math.abs(trade.entryPrice - trade.stopLoss)
    : 0;
  const reward = trade.takeProfit
    ? Math.abs(trade.takeProfit - trade.entryPrice)
    : 0;
  const riskReward = risk > 0 && reward > 0 ? reward / risk : null;
  const reachedExit = trade.exits.some((exit) => {
    const exitMs = timeValue(exit.exitTime);
    return currentCandle && exitMs !== null && exitMs <= currentCandle.time * 1000;
  });

  const selectTrade = (id: string) => {
    setSelectedId(id);
    setPlaying(false);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const extension = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
      const imported = parseTrades(content, extension).map(sanitizeImportedTrade);
      if (!imported.length) throw new Error("文件中没有可导入的交易。 ");
      setTrades((current) => [...imported, ...current]);
      setSelectedId(imported[0].id);
      setImportNotice(`已导入 ${imported.length} 笔交易，文件只在当前浏览器中处理。`);
    } catch (error) {
      setImportNotice(error instanceof Error ? error.message : "导入失败，请检查文件格式。");
    } finally {
      event.target.value = "";
    }
  };

  const updateNotes = (notes: string) => {
    setTrades((current) =>
      current.map((item) => (item.id === trade.id ? { ...item, notes } : item)),
    );
  };

  return (
    <main className="replay-app">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Activity size={19} strokeWidth={2.2} /></div>
          <div>
            <span className="brand-name">复盘舱</span>
            <span className="brand-subtitle">CRYPTO REVIEW</span>
          </div>
        </div>
        <div className="topbar-center">
          <span className="privacy-dot" />
          <span>数据仅保存在此设备</span>
        </div>
        <div className="topbar-actions">
          <span className="date-chip">UTC+8 · {formatDateTime(Date.now())}</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={handleImport}
            className="visually-hidden"
            aria-label="选择交易 CSV 或 JSON 文件"
          />
          <button className="import-button" onClick={() => fileInputRef.current?.click()}>
            <FileUp size={16} />
            导入仓位
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="trade-sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">交易档案</span>
              <h2>我的复盘</h2>
            </div>
            <span className="count-badge">{trades.length}</span>
          </div>
          <div className="trade-list" role="list" aria-label="交易列表">
            {trades.map((item) => {
              const finalPnl = finalTradePnl(item);
              const positive = finalPnl.totalPnl >= 0;
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
                    <span className={`side-badge ${item.side}`}>
                      {item.side === "long" ? "多" : "空"}
                    </span>
                    <ChevronRight size={15} className="chevron" />
                  </div>
                  <div className="trade-list-meta">
                    <span>{formatDateTime(item.entryTime)}</span>
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
          </div>
          <div className="import-hint">
            <FileUp size={17} />
            <div>
              <strong>CSV / JSON</strong>
              <span>支持中英文字段与分批平仓</span>
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
              <div><span>入场价格</span><strong>{formatPrice(trade.entryPrice)}</strong></div>
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
              <div className="chart-title-group">
                <BarChart3 size={16} />
                <strong>K 线回放</strong>
                <span className={`source-chip ${source === "演示行情" ? "demo" : ""}`}>
                  <span />{source}
                </span>
              </div>
              <div className="timeframe-tabs" aria-label="时间框架">
                {(Object.keys(FRAME_LABELS) as TimeFrame[]).map((item) => (
                  <button
                    key={item}
                    className={frame === item ? "active" : ""}
                    onClick={() => setFrame(item)}
                    aria-pressed={frame === item}
                  >
                    {FRAME_LABELS[item]}
                  </button>
                ))}
              </div>
            </div>

            <div className="ohlc-strip" aria-live="polite">
              <span>{currentCandle ? formatDateTime(currentCandle.time * 1000) : "—"}</span>
              <span>开 <b>{currentCandle ? formatPrice(currentCandle.open) : "—"}</b></span>
              <span>高 <b className="tone-profit">{currentCandle ? formatPrice(currentCandle.high) : "—"}</b></span>
              <span>低 <b className="tone-loss">{currentCandle ? formatPrice(currentCandle.low) : "—"}</b></span>
              <span>收 <b>{currentCandle ? formatPrice(currentCandle.close) : "—"}</b></span>
            </div>

            <div className="chart-area">
              <CandleReplayChart
                candles={candles}
                cursor={cursor}
                entryIndex={entryIndex}
                trade={trade}
              />
              {loading && <div className="chart-loading"><span />正在载入历史行情</div>}
              <div className="chart-legend">
                <span><i className="legend-entry" />入场</span>
                <span><i className="legend-exit" />离场</span>
                <span><i className="legend-tp" />止盈</span>
                <span><i className="legend-sl" />止损</span>
              </div>
            </div>

            <div className="replay-controls">
              <button
                className="icon-control"
                onClick={() => { setPlaying(false); setCursor(entryIndex); }}
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
                onClick={() => setPlaying((value) => !value)}
                aria-label={playing ? "暂停回放" : "开始回放"}
              >
                {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
                {playing ? "暂停" : "回放"}
              </button>
              <button className="icon-control" onClick={() => step(1)} aria-label="前进一根 K 线">
                <SkipForward size={17} />
              </button>
              <div className="replay-progress">
                <input
                  type="range"
                  min={entryIndex}
                  max={Math.max(entryIndex, candles.length - 1)}
                  value={Math.min(cursor, Math.max(entryIndex, candles.length - 1))}
                  onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)); }}
                  aria-label="回放进度"
                  style={{ "--progress": `${Math.max(0, Math.min(progress, 100))}%` } as CSSProperties}
                />
                <div>
                  <span>{Math.max(0, cursor - entryIndex + 1)} 根</span>
                  <span>{Math.round(Math.max(0, Math.min(progress, 100)))}%</span>
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
                <div><span>入场成交</span><strong>{formatPrice(trade.entryPrice)}</strong><small>{formatDateTime(trade.entryTime)}</small></div>
              </div>
              <div className="execution-connector" />
              <div className={`execution-event ${reachedExit ? "exit-event" : "pending-event"}`}>
                <span className="event-icon">{reachedExit ? <Target size={15} /> : <Gauge size={15} />}</span>
                <div>
                  <span>{reachedExit ? "离场成交" : "等待回放"}</span>
                  <strong>{reachedExit ? formatPrice(trade.exits.at(-1)?.exitPrice ?? trade.entryPrice) : "未来数据已隐藏"}</strong>
                  <small>{reachedExit ? formatDateTime(trade.exits.at(-1)?.exitTime) : "继续播放以查看后续"}</small>
                </div>
              </div>
            </div>
          </section>
        </section>

        <aside className="review-sidebar">
          <section className="result-card">
            <div className="result-card-heading">
              <div><WalletCards size={17} /><span>回放结果</span></div>
              <span className={`live-pill ${playing ? "playing" : ""}`}><i />{playing ? "回放中" : reachedExit ? "已平仓" : "持仓中"}</span>
            </div>
            <div className={`pnl-hero ${pnlTone}`}>
              <span>当前总盈亏</span>
              <strong>{formatMoney(pnl.totalPnl, true)}</strong>
              <em>{formatPercent(pnl.returnRatePercent, true)}</em>
            </div>
            <div className="pnl-split">
              <div><span>已实现</span><strong>{formatMoney(pnl.realizedPnl, true)}</strong></div>
              <div><span>未实现</span><strong>{formatMoney(pnl.unrealizedPnl, true)}</strong></div>
            </div>
            <div className="metric-list">
              <MetricRow label="入场名义价值" value={formatMoney(pnl.entryNotional)} />
              <MetricRow label="剩余仓位" value={`${pnl.remainingQuantity.toLocaleString("zh-CN")} ${normalizeSymbol(trade.symbol).replace(/USDT$|USDC$/, "")}`} />
              <MetricRow label="累计手续费" value={formatMoney(trade.fee + trade.exits.reduce((sum, exit) => sum + exit.fee, 0))} />
              <MetricRow label="计划风险收益比" value={riskReward ? `1 : ${riskReward.toFixed(2)}` : "未设置"} />
            </div>
          </section>

          <section className="risk-card">
            <div className="section-title"><Target size={16} /><strong>止盈止损设置</strong></div>
            <div className="risk-level tp-level">
              <div><span>TP</span><p>计划止盈<small>{trade.takeProfit ? formatPercent(((trade.takeProfit - trade.entryPrice) / trade.entryPrice) * (trade.side === "long" ? 100 : -100), true) : ""}</small></p></div>
              <strong>{trade.takeProfit ? formatPrice(trade.takeProfit) : "未设置"}</strong>
            </div>
            <div className="risk-level sl-level">
              <div><span>SL</span><p>保护止损<small>{trade.stopLoss ? formatPercent(((trade.stopLoss - trade.entryPrice) / trade.entryPrice) * (trade.side === "long" ? 100 : -100), true) : ""}</small></p></div>
              <strong>{trade.stopLoss ? formatPrice(trade.stopLoss) : "未设置"}</strong>
            </div>
            <p className="risk-footnote">计划线只用于复盘展示；最终盈亏以导入的真实成交为准。</p>
          </section>

          <section className="notes-card">
            <div className="section-title"><BookOpen size={16} /><strong>复盘笔记</strong><span>自动保存</span></div>
            <textarea
              value={trade.notes}
              onChange={(event) => updateNotes(event.target.value)}
              placeholder="记录当时的判断、情绪和下一次要改进的动作…"
              aria-label="复盘笔记"
            />
            <div className="note-prompt"><Sparkles size={14} />这次交易是否严格执行了原计划？</div>
          </section>
        </aside>
      </div>

      <footer className="app-footer">
        <span>CryptoReview · 仅用于交易复盘，不构成投资建议</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
      </footer>
    </main>
  );
}
