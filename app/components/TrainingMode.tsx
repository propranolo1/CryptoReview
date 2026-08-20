"use client";

import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Download,
  FileUp,
  Play,
  RotateCcw,
  SkipForward,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  Logical,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { MarketCandle } from "@/lib/market.mjs";
import {
  buildVolumeCandleColorPoint,
  buildVolumeCandleColorSeries,
  createXinMentorshipAccumulator,
  type VolumeCandleTone,
  type XinMentorshipAccumulator,
  type XinMentorshipConfig,
  type XinMentorshipPoint,
} from "@/lib/indicators.mjs";
import {
  getTrainingDrawingBucketRange,
  getTrainingDrawingLogicalIndex,
  getTrainingDrawingTimeAtLogicalIndex,
  moveTrainingRectangle,
  resizeTrainingRectangle,
  type TrainingRectangleCorner,
} from "@/lib/training-drawings.mjs";
import {
  mergeTrainingResultRecords,
  parseTrainingResultsImport,
  serializeTrainingResultsExport,
} from "@/lib/training-records.mjs";
import {
  applyTrainingAction,
  calculateTrainingPerformance,
  canStartNewTrainingRound,
  cancelTrainingLimitOrder,
  createTrainingSession,
  finishTrainingSession,
  getTrainingAccountSnapshot,
  placeTrainingLimitOrder,
  processTrainingCandle,
  setTrainingRiskLevels,
  type TrainingActionRecord,
  type TrainingLimitOrder,
  type TrainingLimitOrderChangeRecord,
  type TrainingMarketLocation,
  type TrainingPosition,
  type TrainingRiskChangeRecord,
} from "@/lib/training.mjs";
import {
  createRandomTrainingRequest,
  createTrainingContinuationRequest,
  createTrainingHistoryRequest,
  mergeTrainingHistoryPages,
  prepareTrainingCandles,
  prepareTrainingContinuationCandles,
  type TrainingInterval,
} from "@/lib/training-market.mjs";
import {
  classifyTrainingSeriesUpdate,
  type TrainingSeriesCursor,
} from "@/lib/training-chart-update.mjs";
import {
  buildTrainingSessionSummary,
  calculateTrainingAnalyticsPerformance,
  calculateTrainingRiskExpectation,
  type TrainingRiskExpectation,
  type TrainingSessionSummary,
} from "@/lib/training-analytics.mjs";
import { createReplayTimeframeAggregator } from "@/lib/video-timeframes.mjs";
import { PerformanceDistributionCharts } from "./PerformanceDistributionCharts";
import styles from "./TrainingMode.module.css";

type TrainingView = "trade" | "performance";
type TrainingSession = ReturnType<typeof createTrainingSession>;
type FinishedTrainingSession = ReturnType<typeof finishTrainingSession>;
type OrderRatio = 0.1 | 0.25 | 0.5 | 1;
type TrainingRiskKind = "takeProfit" | "stopLoss";
type TrainingMiniTimeframe = "4H" | "1D";
type TrainingMainTimeframe = "15m" | "1H" | "4H" | "1D";
type TrainingDrawingMode = "none" | "horizontal" | "rectangle";
type TrainingRectangleDragMode = "move" | TrainingRectangleCorner;

type TrainingDrawingPoint = {
  time: number;
  price: number;
};

type TrainingChartDrawing =
  | {
      id: string;
      kind: "horizontal";
      price: number;
      color: string;
    }
  | {
      id: string;
      kind: "rectangle";
      startTime: number;
      endTime: number;
      topPrice: number;
      bottomPrice: number;
      color: string;
    };

type TrainingProjectedDrawing =
  | {
      id: string;
      kind: "horizontal";
      y: number;
      color: string;
    }
  | {
      id: string;
      kind: "rectangle";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
    };

type TrainingMarker = {
  id: string;
  actionId?: string;
  time: number;
  direction: "buy" | "sell";
  label: string;
  price: number;
};

type TrainingContext = {
  sessionId: string;
  interval: TrainingInterval;
  source: string;
  initialCursor: number;
  windowStartTime: number;
  windowEndTime: number;
};

export type TrainingResultRecord = FinishedTrainingSession & {
  interval: TrainingInterval;
  source: string;
  windowStartTime: number;
  windowEndTime: number;
  barsViewed: number;
  markers: TrainingMarker[];
  recordedAt: string;
  mainTimeframe?: TrainingMainTimeframe;
  summary?: TrainingSessionSummary;
};

type TrainingModeProps = {
  trainingResults: TrainingResultRecord[];
  onResultsChange: (results: TrainingResultRecord[]) => void;
};

const INTERVAL_LABELS: Record<TrainingInterval, string> = {
  "5m": "5 分钟",
  "15m": "15 分钟",
  "1h": "1 小时",
  "4h": "4 小时",
};
const TRAINING_MAIN_INTERVAL: TrainingInterval = "15m";
const TRAINING_MAIN_TIMEFRAME_LABELS: Record<TrainingMainTimeframe, string> = {
  "15m": "15 分钟",
  "1H": "1 小时",
  "4H": "4 小时",
  "1D": "1 天",
};
const TRAINING_MAIN_TIMEFRAME_SECONDS: Record<TrainingMainTimeframe, number> = {
  "15m": 15 * 60,
  "1H": 60 * 60,
  "4H": 4 * 60 * 60,
  "1D": 24 * 60 * 60,
};
const TRAINING_CONTEXT_CANDLES = 8_640;
const TRAINING_FUTURE_CANDLES = 160;
const TRAINING_REQUIRED_CANDLES =
  TRAINING_CONTEXT_CANDLES + TRAINING_FUTURE_CANDLES;
const TRAINING_REQUEST_PAGE_SIZE = 1_000;
const TRAINING_MAIN_VISIBLE_CANDLES = 80;
const TRAINING_MINI_VISIBLE_CANDLES: Record<TrainingMiniTimeframe, number> = {
  "4H": 30,
  "1D": 90,
};
const TRAINING_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
const TRAINING_VOLUME_CANDLE_COLORS = {
  bullish: "#00df3b",
  bearish: "#ff304f",
  low: "#ffd400",
} as const;
const TRAINING_DRAWING_COLORS = [
  { label: "灰色", value: "#6b7280" },
  { label: "绿色", value: "#16a34a" },
  { label: "红色", value: "#dc2626" },
] as const;
type TrainingDrawingColor = (typeof TRAINING_DRAWING_COLORS)[number]["value"];

function randomUnit() {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0] / 0x1_0000_0000;
}

function isTrainingKeyboardInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.matches("input, textarea, select") ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"], [role="textbox"]'))
  );
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMoney(value: number, showSign = false) {
  const sign = value < 0 ? "−" : showSign && value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value))} USDT`;
}

function formatPercent(value: number, showSign = false) {
  const sign = value < 0 ? "−" : showSign && value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function formatDateTime(value: string | number) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function formatTrainingDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const totalMinutes = Math.max(0, Math.round(value / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`;
}

function formatRMultiple(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "未建立 R 基准";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function buildTrainingCandleDatum(
  candle: MarketCandle,
  tone: VolumeCandleTone | null,
) {
  const fillColor = tone
    ? TRAINING_VOLUME_CANDLE_COLORS[tone]
    : candle.close >= candle.open ? "transparent" : "#111111";
  return {
    time: candle.time as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    color: fillColor,
    borderColor: "#111111",
    wickColor: "#111111",
  };
}

function buildTrainingCandleData(candles: readonly MarketCandle[]) {
  const colorPoints = buildVolumeCandleColorSeries([...candles]).points;
  return candles.map((candle, index) =>
    buildTrainingCandleDatum(candle, colorPoints[index]?.tone ?? null)
  );
}

function buildTrainingCandleDataWindow(
  candles: readonly MarketCandle[],
  startIndex: number,
) {
  return candles.slice(startIndex).map((candle, offset) => {
    const index = startIndex + offset;
    return buildTrainingCandleDatum(
      candle,
      buildVolumeCandleColorPoint(candles, index).tone,
    );
  });
}

function buildTrainingVolumeDatum(candle: MarketCandle) {
  return {
    time: candle.time as UTCTimestamp,
    value: candle.volume,
    color: candle.close >= candle.open
      ? "rgba(48, 196, 135, 0.58)"
      : "rgba(239, 101, 114, 0.58)",
  };
}

function buildTrainingXinSeriesPoint(
  point: XinMentorshipPoint,
  config: XinMentorshipConfig,
) {
  return {
    wt1: point.wt1 === null
      ? null
      : {
          time: point.time as UTCTimestamp,
          value: point.wt1,
          color: point.wt1 > config.overbought2
            ? "rgba(255, 23, 68, 0.90)"
            : point.wt1 > config.overbought1
              ? "rgba(255, 23, 68, 0.62)"
              : point.wt1 < config.oversold2
                ? "rgba(0, 230, 118, 0.90)"
                : point.wt1 < config.oversold1
                  ? "rgba(0, 230, 118, 0.62)"
                  : "rgba(73, 148, 236, 0.76)",
        },
    wt2: point.wt2 === null
      ? null
      : { time: point.time as UTCTimestamp, value: point.wt2 },
    mfi: point.mfi === null
      ? null
      : {
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
        },
    momentum: point.momentum === null
      ? null
      : {
          time: point.time as UTCTimestamp,
          value: point.momentum,
          color: point.momentum >= 0
            ? point.momentumDelta !== null && point.momentumDelta > 0
              ? "rgba(0, 230, 118, 0.78)"
              : "rgba(0, 230, 118, 0.34)"
            : point.momentumDelta !== null && point.momentumDelta < 0
              ? "rgba(255, 23, 68, 0.78)"
              : "rgba(255, 23, 68, 0.34)",
        },
  };
}

function buildTrainingXinPointMarkers(point: XinMentorshipPoint) {
  const markers: SeriesMarker<Time>[] = [];
  if (point.signal) {
    const buy = point.signal.includes("buy");
    markers.push({
      id: `training-xin-${point.signal}-${point.time}`,
      time: point.time as UTCTimestamp,
      position: buy ? "belowBar" : "aboveBar",
      color: point.signal === "gold-buy"
        ? "#ffd600"
        : buy ? "#00c853" : "#d50000",
      shape: buy ? "arrowUp" : "arrowDown",
      text: point.signal === "gold-buy"
        ? "GOLD"
        : point.signal.startsWith("strong")
          ? (buy ? "BUY+" : "SELL+")
          : (buy ? "B" : "S"),
      size: point.signal.includes("strong") ? 1.4 : 1,
    });
  }
  if (point.preBearWarning || point.preBullWarning) {
    const bullish = point.preBullWarning;
    markers.push({
      id: `training-xin-warning-${point.time}`,
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
    markers.push({
      id: `training-xin-div-${point.divergenceTime}-${bullish ? "bull" : "bear"}`,
      time: point.divergenceTime as UTCTimestamp,
      position: bullish ? "belowBar" : "aboveBar",
      color: bullish ? "#00e676" : "#ff1744",
      shape: "circle",
      text: "DIV",
      size: 0.8,
    });
  }
  return markers;
}

function createTrainingMarketLocation({
  candle,
  candleIndex,
  context,
  timing,
}: {
  candle: MarketCandle;
  candleIndex: number;
  context: TrainingContext;
  timing: TrainingMarketLocation["timing"];
}): TrainingMarketLocation {
  return {
    interval: context.interval,
    candleOpenTimeMs: candle.time * 1000,
    candleCloseTimeMs: candle.closeTime,
    candleIndex,
    revealedOffset: Math.max(0, candleIndex - context.initialCursor),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    timing,
  };
}

function formatBtcQuantity(value: number) {
  return `${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(value)} BTC`;
}

function classifyTrainingRiskPrice(
  side: "long" | "short",
  averagePrice: number,
  price: number,
): TrainingRiskKind | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (Math.abs(price - averagePrice) < 0.005) return null;
  const isProfitDirection = side === "long"
    ? price > averagePrice
    : price < averagePrice;
  return isProfitDirection ? "takeProfit" : "stopLoss";
}

function trainingProjectedDrawingsEqual(
  left: readonly TrainingProjectedDrawing[],
  right: readonly TrainingProjectedDrawing[],
) {
  if (left.length !== right.length) return false;
  return left.every((drawing, index) => {
    const candidate = right[index];
    if (!candidate || drawing.id !== candidate.id || drawing.kind !== candidate.kind) {
      return false;
    }
    if (drawing.kind === "horizontal" && candidate.kind === "horizontal") {
      return drawing.y === candidate.y && drawing.color === candidate.color;
    }
    if (drawing.kind === "rectangle" && candidate.kind === "rectangle") {
      return (
        drawing.x === candidate.x &&
        drawing.y === candidate.y &&
        drawing.width === candidate.width &&
        drawing.height === candidate.height &&
        drawing.color === candidate.color
      );
    }
    return false;
  });
}

function useTrainingDrawingProjection({
  ready,
  timeframe,
  candles,
  drawings,
  dataVersion,
  chartRef,
  seriesRef,
  containerRef,
}: {
  ready: boolean;
  timeframe: TrainingMainTimeframe;
  candles: readonly MarketCandle[];
  drawings: readonly TrainingChartDrawing[];
  dataVersion: string;
  chartRef: { current: IChartApi | null };
  seriesRef: { current: ISeriesApi<"Candlestick"> | null };
  containerRef: { current: HTMLDivElement | null };
}) {
  const [projectedDrawings, setProjectedDrawings] = useState<
    TrainingProjectedDrawing[]
  >([]);
  const projectionFrameRef = useRef<number | null>(null);

  const syncDrawingOverlay = useCallback(() => {
    const chart = chartRef.current;
    const candleSeries = seriesRef.current;
    const container = containerRef.current;
    if (!chart || !candleSeries || !container) {
      setProjectedDrawings((current) => current.length === 0 ? current : []);
      return;
    }
    if (drawings.length === 0 || candles.length === 0) {
      setProjectedDrawings((current) => current.length === 0 ? current : []);
      return;
    }

    const projected: TrainingProjectedDrawing[] = [];
    drawings.forEach((drawing) => {
      if (drawing.kind === "horizontal") {
        const y = candleSeries.priceToCoordinate(drawing.price);
        if (y !== null && Number.isFinite(y)) {
          projected.push({
            id: drawing.id,
            kind: drawing.kind,
            y,
            color: drawing.color,
          });
        }
        return;
      }

      const bucketRange = getTrainingDrawingBucketRange({
        startTime: drawing.startTime,
        endTime: drawing.endTime,
        timeframe,
      });
      const coordinateForTime = (time: number) => {
        const direct = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
        if (direct !== null) return direct;
        const logicalIndex = getTrainingDrawingLogicalIndex({
          candles,
          time,
          timeframe,
        });
        return chart.timeScale().logicalToCoordinate(logicalIndex as Logical);
      };
      const startX = coordinateForTime(bucketRange.startTime);
      const endX = coordinateForTime(bucketRange.endTime);
      const topY = candleSeries.priceToCoordinate(drawing.topPrice);
      const bottomY = candleSeries.priceToCoordinate(drawing.bottomPrice);
      if (startX === null || endX === null || topY === null || bottomY === null) {
        return;
      }
      const rawWidth = Math.abs(endX - startX);
      const width = Math.max(6, rawWidth);
      projected.push({
        id: drawing.id,
        kind: drawing.kind,
        x: Math.min(startX, endX) - (rawWidth < 6 ? (6 - rawWidth) / 2 : 0),
        y: Math.min(topY, bottomY),
        width,
        height: Math.abs(bottomY - topY),
        color: drawing.color,
      });
    });
    setProjectedDrawings((current) =>
      trainingProjectedDrawingsEqual(current, projected) ? current : projected
    );
  }, [candles, chartRef, containerRef, drawings, seriesRef, timeframe]);

  const scheduleDrawingOverlay = useCallback(() => {
    if (projectionFrameRef.current !== null) return;
    projectionFrameRef.current = window.requestAnimationFrame(() => {
      projectionFrameRef.current = null;
      syncDrawingOverlay();
    });
  }, [syncDrawingOverlay]);

  useEffect(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!ready || !chart || !container) return;

    const timeScale = chart.timeScale();
    const resizeObserver = new ResizeObserver(scheduleDrawingOverlay);
    timeScale.subscribeVisibleLogicalRangeChange(scheduleDrawingOverlay);
    resizeObserver.observe(container);
    scheduleDrawingOverlay();
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(scheduleDrawingOverlay);
      resizeObserver.disconnect();
      if (projectionFrameRef.current !== null) {
        window.cancelAnimationFrame(projectionFrameRef.current);
        projectionFrameRef.current = null;
      }
    };
  }, [ready, scheduleDrawingOverlay, chartRef, containerRef]);

  useEffect(() => {
    if (ready) scheduleDrawingOverlay();
  }, [dataVersion, ready, scheduleDrawingOverlay]);

  return projectedDrawings;
}

function TrainingDrawingOverlay({
  className,
  drawings,
  interactive = false,
  selectedDrawingId = null,
  onRectanglePointerDown,
  onContextMenu,
}: {
  className: string;
  drawings: readonly TrainingProjectedDrawing[];
  interactive?: boolean;
  selectedDrawingId?: string | null;
  onRectanglePointerDown?: (
    event: React.PointerEvent<SVGElement>,
    drawingId: string,
    mode: TrainingRectangleDragMode,
  ) => void;
  onContextMenu?: (event: React.MouseEvent<SVGElement>) => void;
}) {
  return (
    <svg
      className={className}
      aria-hidden={!interactive}
      onContextMenu={onContextMenu}
    >
      {drawings.map((drawing) => drawing.kind === "horizontal" ? (
        <line
          key={drawing.id}
          x1={0}
          x2="100%"
          y1={drawing.y}
          y2={drawing.y}
          stroke={drawing.color}
          strokeWidth={2}
        />
      ) : (() => {
        const selected = interactive && drawing.id === selectedDrawingId;
        const handles: Array<{
          corner: TrainingRectangleCorner;
          x: number;
          y: number;
        }> = [
          { corner: "topLeft", x: drawing.x, y: drawing.y },
          { corner: "topRight", x: drawing.x + drawing.width, y: drawing.y },
          { corner: "bottomLeft", x: drawing.x, y: drawing.y + drawing.height },
          {
            corner: "bottomRight",
            x: drawing.x + drawing.width,
            y: drawing.y + drawing.height,
          },
        ];
        return (
          <g key={drawing.id}>
            <rect
              className={styles.drawingRectangle}
              x={drawing.x}
              y={drawing.y}
              width={drawing.width}
              height={drawing.height}
              fill={drawing.color}
              fillOpacity={selected ? 0.27 : 0.2}
              stroke={drawing.color}
              strokeWidth={selected ? 3 : 2}
              pointerEvents={interactive ? "all" : "none"}
              onPointerDown={interactive && onRectanglePointerDown
                ? (event) => onRectanglePointerDown(event, drawing.id, "move")
                : undefined}
            />
            {selected && handles.map((handle) => (
              <circle
                key={handle.corner}
                className={styles.drawingHandle}
                cx={handle.x}
                cy={handle.y}
                r={5}
                fill="#ffffff"
                stroke={drawing.color}
                strokeWidth={2}
                pointerEvents="all"
                onPointerDown={onRectanglePointerDown
                  ? (event) => onRectanglePointerDown(
                      event,
                      drawing.id,
                      handle.corner,
                    )
                  : undefined}
              />
            ))}
          </g>
        );
      })())}
    </svg>
  );
}

function TrainingMiniChart({
  label,
  candles,
  sessionId,
  drawings,
}: {
  label: TrainingMiniTimeframe;
  candles: readonly MarketCandle[];
  sessionId: string;
  drawings: readonly TrainingChartDrawing[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const seriesCursorRef = useRef<TrainingSeriesCursor | null>(null);
  const viewportSessionIdRef = useRef<string | null>(null);
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
          background: { type: library.ColorType.Solid, color: "#ffffff" },
          textColor: "#667085",
          attributionLogo: false,
          panes: {
            enableResize: true,
            separatorColor: "rgba(17, 24, 39, 0.1)",
            separatorHoverColor: "rgba(41, 98, 255, 0.18)",
          },
        },
        grid: {
          vertLines: { color: "transparent" },
          horzLines: { color: "rgba(17, 24, 39, 0.07)" },
        },
        crosshair: {
          mode: library.CrosshairMode.Normal,
          vertLine: {
            color: "rgba(17, 24, 39, 0.14)",
            labelVisible: false,
          },
          horzLine: {
            color: "rgba(17, 24, 39, 0.12)",
            labelBackgroundColor: "#475467",
          },
        },
        handleScroll: true,
        handleScale: true,
        rightPriceScale: {
          borderColor: "rgba(17, 24, 39, 0.12)",
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          borderColor: "rgba(17, 24, 39, 0.12)",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 2,
          barSpacing: 6,
          minBarSpacing: 2,
          fixLeftEdge: false,
        },
        localization: {
          locale: "zh-CN",
          priceFormatter: formatPrice,
        },
      });

      const series = chart.addSeries(library.CandlestickSeries, {
        upColor: "transparent",
        downColor: "#111111",
        borderVisible: true,
        borderUpColor: "#111111",
        borderDownColor: "#111111",
        wickUpColor: "#111111",
        wickDownColor: "#111111",
        priceLineVisible: true,
        priceLineColor: "#2962ff",
        priceLineWidth: 1,
        priceLineStyle: library.LineStyle.Dotted,
        lastValueVisible: true,
      }, 0);
      const volumeSeries = chart.addSeries(library.HistogramSeries, {
        priceScaleId: "right",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: true,
        base: 0,
      }, 1);
      const panes = chart.panes();
      panes[0]?.setStretchFactor(4);
      panes[1]?.setStretchFactor(1);

      chartRef.current = chart;
      seriesRef.current = series;
      volumeSeriesRef.current = volumeSeries;
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
      volumeSeriesRef.current = null;
      seriesCursorRef.current = null;
      viewportSessionIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!ready || !chart || !series || !volumeSeries) return;

    const seriesKey = `${sessionId}:${label}`;
    const update = classifyTrainingSeriesUpdate(
      seriesCursorRef.current,
      seriesKey,
      candles,
    );
    seriesCursorRef.current = update.cursor;
    const visibleCount = TRAINING_MINI_VISIBLE_CANDLES[label];
    const visibleStart = Math.max(0, candles.length - visibleCount);
    const visible = candles.slice(visibleStart);
    const latest = candles.at(-1);
    if (update.mode === "reset") {
      series.setData(buildTrainingCandleDataWindow(candles, visibleStart));
      volumeSeries.setData(visible.map(buildTrainingVolumeDatum));
    } else if (update.mode === "update-last" && latest) {
      const tone = buildVolumeCandleColorPoint(candles, candles.length - 1).tone;
      series.update(buildTrainingCandleDatum(latest, tone));
      volumeSeries.update(buildTrainingVolumeDatum(latest));
    } else if (update.mode === "append" && latest) {
      if (candles.length <= visibleCount) {
        const tone = buildVolumeCandleColorPoint(candles, candles.length - 1).tone;
        series.update(buildTrainingCandleDatum(latest, tone));
        volumeSeries.update(buildTrainingVolumeDatum(latest));
      } else {
        series.setData(buildTrainingCandleDataWindow(candles, visibleStart));
        volumeSeries.setData(visible.map(buildTrainingVolumeDatum));
      }
    }
    if (
      visible.length > 0 &&
      viewportSessionIdRef.current !== sessionId
    ) {
      chart.timeScale().setVisibleLogicalRange({
        from: visible.length - visibleCount,
        to: visible.length + 2,
      });
      viewportSessionIdRef.current = sessionId;
    }
  }, [candles, label, ready, sessionId]);

  const projectedDrawings = useTrainingDrawingProjection({
    ready,
    timeframe: label,
    candles: candles.slice(
      Math.max(0, candles.length - TRAINING_MINI_VISIBLE_CANDLES[label]),
    ),
    drawings,
    dataVersion: `${candles.length}:${candles.at(-1)?.time ?? "empty"}:${candles.at(-1)?.high ?? 0}:${candles.at(-1)?.low ?? 0}`,
    chartRef,
    seriesRef,
    containerRef,
  });

  const latest = candles.at(-1);
  return (
    <article className={styles.trainingMiniChart}>
      <header>
        <strong>{label}</strong>
        <span>
          {latest
            ? `${Math.min(candles.length, TRAINING_MINI_VISIBLE_CANDLES[label])} 根 · 收 ${formatPrice(latest.close)}`
            : "等待已揭示行情"}
        </span>
      </header>
      <div className={styles.trainingMiniCanvas} ref={containerRef} aria-hidden="true" />
      <TrainingDrawingOverlay
        className={styles.trainingMiniDrawingOverlay}
        drawings={projectedDrawings}
      />
      {!ready && (
        <div className={styles.trainingMiniPlaceholder}>正在准备 {label} 图表…</div>
      )}
    </article>
  );
}

function TrainingChart({
  sessionId,
  timeframe,
  candles,
  markers,
  averagePrice,
  positionSide,
  takeProfit,
  stopLoss,
  takeProfitLabel,
  stopLossLabel,
  limitOrders,
  drawings,
  canPlaceLimitOrder,
  onPlaceLimitOrder,
  onCancelLimitOrder,
  onDrawingsChange,
  onRiskPriceChange,
}: {
  sessionId: string;
  timeframe: TrainingMainTimeframe;
  candles: readonly MarketCandle[];
  markers: TrainingMarker[];
  averagePrice: number | null;
  positionSide: "long" | "short" | null;
  takeProfit: number | null;
  stopLoss: number | null;
  takeProfitLabel: string;
  stopLossLabel: string;
  limitOrders: readonly TrainingLimitOrder[];
  drawings: readonly TrainingChartDrawing[];
  canPlaceLimitOrder: boolean;
  onPlaceLimitOrder: (
    side: "buy" | "sell",
    price: number,
    ratio: OrderRatio,
  ) => void;
  onCancelLimitOrder: (limitOrderId: string) => void;
  onDrawingsChange: (drawings: TrainingChartDrawing[]) => void;
  onRiskPriceChange: (kind: TrainingRiskKind, price: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const xinWt1SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const xinWt2SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const xinMfiSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const xinMomentumSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const xinMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const costLineRef = useRef<IPriceLine | null>(null);
  const takeProfitLineRef = useRef<IPriceLine | null>(null);
  const stopLossLineRef = useRef<IPriceLine | null>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const limitOrderLineRefs = useRef<Map<string, IPriceLine>>(new Map());
  const limitOrderLineSignaturesRef = useRef<Map<string, string>>(new Map());
  const seriesCursorRef = useRef<TrainingSeriesCursor | null>(null);
  const xinAccumulatorRef = useRef<XinMentorshipAccumulator | null>(null);
  const xinChartMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const xinLastPointMarkerIdsRef = useRef<string[]>([]);
  const tradeMarkerSignatureRef = useRef("");
  const costLineValueRef = useRef<number | null | undefined>(undefined);
  const takeProfitLineValueRef = useRef<number | null | undefined>(undefined);
  const stopLossLineValueRef = useRef<number | null | undefined>(undefined);
  const takeProfitLineLabelRef = useRef<string | undefined>(undefined);
  const stopLossLineLabelRef = useRef<string | undefined>(undefined);
  const viewportSessionIdRef = useRef<string | null>(null);
  const drawingSequenceRef = useRef(0);
  const rectangleDragCleanupRef = useRef<(() => void) | null>(null);
  const chartPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const ignoreNextChartClickRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [limitMenu, setLimitMenu] = useState<{
    x: number;
    y: number;
    price: number;
  } | null>(null);
  const [cancelLimitMenu, setCancelLimitMenu] = useState<{
    x: number;
    y: number;
    order: TrainingLimitOrder;
  } | null>(null);
  const [limitRatio, setLimitRatio] = useState<OrderRatio>(0.25);
  const [drawingMode, setDrawingMode] = useState<TrainingDrawingMode>("none");
  const [drawingColor, setDrawingColor] = useState<TrainingDrawingColor>("#6b7280");
  const [drawingAnchor, setDrawingAnchor] = useState<TrainingDrawingPoint | null>(null);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let chart: IChartApi | null = null;
    const limitOrderLines = limitOrderLineRefs.current;
    const limitOrderLineSignatures = limitOrderLineSignaturesRef.current;

    void (async () => {
      const library = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;

      chart = library.createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: library.ColorType.Solid, color: "#ffffff" },
          textColor: "#667085",
          attributionLogo: false,
          panes: {
            enableResize: true,
            separatorColor: "rgba(17, 24, 39, 0.12)",
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
          borderColor: "rgba(17, 24, 39, 0.16)",
          scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
          borderColor: "rgba(17, 24, 39, 0.16)",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
          barSpacing: 8,
          minBarSpacing: 3,
          fixLeftEdge: true,
        },
        localization: {
          locale: "zh-CN",
          priceFormatter: formatPrice,
        },
      });

      const candleSeries = chart.addSeries(library.CandlestickSeries, {
        upColor: "transparent",
        downColor: "#111111",
        borderVisible: true,
        borderUpColor: "#111111",
        borderDownColor: "#111111",
        wickUpColor: "#111111",
        wickDownColor: "#111111",
        priceLineVisible: true,
        priceLineColor: "#2962ff",
        priceLineWidth: 1,
        priceLineStyle: library.LineStyle.Dotted,
        lastValueVisible: true,
      }, 0);
      const volumeSeries = chart.addSeries(library.HistogramSeries, {
        priceScaleId: "right",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: true,
        base: 0,
      }, 1);
      const xinMomentumSeries = chart.addSeries(library.HistogramSeries, {
        priceScaleId: "right",
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        priceLineVisible: false,
        lastValueVisible: false,
        base: 0,
      }, 2);
      const xinMfiSeries = chart.addSeries(library.AreaSeries, {
        priceScaleId: "right",
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        lineColor: "rgba(0, 230, 118, 0.42)",
        topColor: "rgba(0, 230, 118, 0.16)",
        bottomColor: "rgba(255, 23, 68, 0.10)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }, 2);
      const xinWt1Series = chart.addSeries(library.LineSeries, {
        priceScaleId: "right",
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        color: "#4994ec",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
      }, 2);
      const xinWt2Series = chart.addSeries(library.LineSeries, {
        priceScaleId: "right",
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        color: "rgba(26, 35, 126, 0.78)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }, 2);
      const markerApi = library.createSeriesMarkers(candleSeries, [], { autoScale: true });
      const xinMarkerApi = library.createSeriesMarkers(
        xinWt1Series,
        [],
        { autoScale: true },
      );
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
      const panes = chart.panes();
      panes[0]?.setStretchFactor(4);
      panes[1]?.setStretchFactor(1);
      panes[2]?.setStretchFactor(2);

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      volumeSeriesRef.current = volumeSeries;
      xinWt1SeriesRef.current = xinWt1Series;
      xinWt2SeriesRef.current = xinWt2Series;
      xinMfiSeriesRef.current = xinMfiSeries;
      xinMomentumSeriesRef.current = xinMomentumSeries;
      xinMarkersRef.current = xinMarkerApi;
      markersRef.current = markerApi;
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
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      xinWt1SeriesRef.current = null;
      xinWt2SeriesRef.current = null;
      xinMfiSeriesRef.current = null;
      xinMomentumSeriesRef.current = null;
      xinMarkersRef.current = null;
      markersRef.current = null;
      costLineRef.current = null;
      takeProfitLineRef.current = null;
      stopLossLineRef.current = null;
      previewLineRef.current = null;
      limitOrderLines.clear();
      limitOrderLineSignatures.clear();
      seriesCursorRef.current = null;
      xinAccumulatorRef.current = null;
      xinChartMarkersRef.current = [];
      xinLastPointMarkerIdsRef.current = [];
      tradeMarkerSignatureRef.current = "";
      costLineValueRef.current = undefined;
      takeProfitLineValueRef.current = undefined;
      stopLossLineValueRef.current = undefined;
      takeProfitLineLabelRef.current = undefined;
      stopLossLineLabelRef.current = undefined;
      viewportSessionIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    drawingSequenceRef.current = 0;
    setDrawingAnchor(null);
    setDrawingMode("none");
  }, [sessionId]);

  useEffect(() => {
    setDrawingAnchor(null);
    setDrawingMode("none");
  }, [timeframe]);

  useEffect(() => () => {
    rectangleDragCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (
      selectedDrawingId &&
      !drawings.some((drawing) => drawing.id === selectedDrawingId)
    ) {
      setSelectedDrawingId(null);
    }
  }, [drawings, selectedDrawingId]);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const xinWt1Series = xinWt1SeriesRef.current;
    const xinWt2Series = xinWt2SeriesRef.current;
    const xinMfiSeries = xinMfiSeriesRef.current;
    const xinMomentumSeries = xinMomentumSeriesRef.current;
    const xinMarkerApi = xinMarkersRef.current;
    const markerApi = markersRef.current;
    if (
      !ready ||
      !chart ||
      !candleSeries ||
      !volumeSeries ||
      !markerApi ||
      !xinWt1Series ||
      !xinWt2Series ||
      !xinMfiSeries ||
      !xinMomentumSeries ||
      !xinMarkerApi ||
      candles.length === 0
    ) {
      return;
    }

    const seriesKey = `${sessionId}:${timeframe}`;
    const classifiedUpdate = classifyTrainingSeriesUpdate(
      seriesCursorRef.current,
      seriesKey,
      candles,
    );
    let updateMode = classifiedUpdate.mode;
    const accumulator = xinAccumulatorRef.current;
    if (
      updateMode !== "reset" &&
      (
        !accumulator ||
        (updateMode === "append" && accumulator.length !== candles.length - 1) ||
        (updateMode === "update-last" && accumulator.length !== candles.length)
      )
    ) {
      updateMode = "reset";
    }
    seriesCursorRef.current = classifiedUpdate.cursor;
    const latestCandle = candles.at(-1)!;
    if (updateMode === "reset") {
      candleSeries.setData(buildTrainingCandleData(candles));
      volumeSeries.setData(candles.map(buildTrainingVolumeDatum));
    } else if (updateMode === "append" || updateMode === "update-last") {
      const tone = buildVolumeCandleColorPoint(candles, candles.length - 1).tone;
      candleSeries.update(buildTrainingCandleDatum(latestCandle, tone));
      volumeSeries.update(buildTrainingVolumeDatum(latestCandle));
    }

    const markerIntervalSeconds = TRAINING_MAIN_TIMEFRAME_SECONDS[timeframe];
    const markerSignature = `${timeframe}|${markers.map((marker) =>
      `${marker.id}:${marker.time}:${marker.direction}:${marker.label}`
    ).join("|")}`;
    if (tradeMarkerSignatureRef.current !== markerSignature) {
      const chartMarkers: SeriesMarker<Time>[] = markers.map((marker) => ({
        id: marker.id,
        time: (
          Math.floor(marker.time / markerIntervalSeconds) * markerIntervalSeconds
        ) as UTCTimestamp,
        position: marker.direction === "buy" ? "belowBar" : "aboveBar",
        color: marker.direction === "buy" ? "#30c487" : "#ef6572",
        shape: marker.direction === "buy" ? "arrowUp" : "arrowDown",
        text: marker.label,
        size: 1.3,
      }));
      markerApi.setMarkers(chartMarkers);
      tradeMarkerSignatureRef.current = markerSignature;
    }

    let xinPoint: XinMentorshipPoint | null = null;
    let xinConfig: XinMentorshipConfig;
    if (updateMode === "reset") {
      const nextAccumulator = createXinMentorshipAccumulator();
      candles.forEach((candle) => nextAccumulator.append(candle));
      xinAccumulatorRef.current = nextAccumulator;
      const xin = nextAccumulator.snapshot();
      xinConfig = xin.config;
      const xinSeries = xin.points.map((point) =>
        buildTrainingXinSeriesPoint(point, xin.config)
      );
      xinWt1Series.setData(xinSeries.flatMap((point) => point.wt1 ? [point.wt1] : []));
      xinWt2Series.setData(xinSeries.flatMap((point) => point.wt2 ? [point.wt2] : []));
      xinMfiSeries.setData(xinSeries.flatMap((point) => point.mfi ? [point.mfi] : []));
      xinMomentumSeries.setData(
        xinSeries.flatMap((point) => point.momentum ? [point.momentum] : []),
      );
      xinChartMarkersRef.current = xin.points
        .flatMap(buildTrainingXinPointMarkers)
        .sort((left, right) => Number(left.time) - Number(right.time));
      xinMarkerApi.setMarkers(xinChartMarkersRef.current);
      xinLastPointMarkerIdsRef.current = buildTrainingXinPointMarkers(
        xin.points.at(-1)!,
      ).map((marker) => String(marker.id));
    } else {
      const nextAccumulator = xinAccumulatorRef.current!;
      xinPoint = updateMode === "append"
        ? nextAccumulator.append(latestCandle)
        : updateMode === "update-last"
          ? nextAccumulator.replaceLast(latestCandle)
          : null;
      xinConfig = nextAccumulator.config;
      if (xinPoint) {
        const xinSeriesPoint = buildTrainingXinSeriesPoint(xinPoint, xinConfig);
        if (xinSeriesPoint.wt1) xinWt1Series.update(xinSeriesPoint.wt1);
        if (xinSeriesPoint.wt2) xinWt2Series.update(xinSeriesPoint.wt2);
        if (xinSeriesPoint.mfi) xinMfiSeries.update(xinSeriesPoint.mfi);
        if (xinSeriesPoint.momentum) {
          xinMomentumSeries.update(xinSeriesPoint.momentum);
        }
      }
    }
    if (updateMode !== "reset" && xinPoint) {
      const pointMarkers = buildTrainingXinPointMarkers(xinPoint);
      const previousIds = updateMode === "update-last"
        ? new Set(xinLastPointMarkerIdsRef.current)
        : new Set<string>();
      if (pointMarkers.length > 0 || previousIds.size > 0) {
        xinChartMarkersRef.current = [
          ...xinChartMarkersRef.current.filter(
            (marker) => !previousIds.has(String(marker.id)),
          ),
          ...pointMarkers,
        ].sort((left, right) => Number(left.time) - Number(right.time));
        xinMarkerApi.setMarkers(xinChartMarkersRef.current);
      }
      xinLastPointMarkerIdsRef.current = pointMarkers.map(
        (marker) => String(marker.id),
      );
    }

    if (costLineValueRef.current !== averagePrice) {
      if (averagePrice === null) {
        if (costLineRef.current) candleSeries.removePriceLine(costLineRef.current);
        costLineRef.current = null;
      } else if (costLineRef.current) {
        costLineRef.current.applyOptions({ price: averagePrice });
      } else {
        costLineRef.current = candleSeries.createPriceLine({
          price: averagePrice,
          color: "#b77900",
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "成本",
        });
      }
      costLineValueRef.current = averagePrice;
    }
    if (
      takeProfitLineValueRef.current !== takeProfit ||
      takeProfitLineLabelRef.current !== takeProfitLabel
    ) {
      if (takeProfit === null) {
        if (takeProfitLineRef.current) {
          candleSeries.removePriceLine(takeProfitLineRef.current);
        }
        takeProfitLineRef.current = null;
      } else if (takeProfitLineRef.current) {
        takeProfitLineRef.current.applyOptions({
          price: takeProfit,
          title: takeProfitLabel,
        });
      } else {
        takeProfitLineRef.current = candleSeries.createPriceLine({
          price: takeProfit,
          color: "#30c487",
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: takeProfitLabel,
        });
      }
      takeProfitLineValueRef.current = takeProfit;
      takeProfitLineLabelRef.current = takeProfitLabel;
    }
    if (
      stopLossLineValueRef.current !== stopLoss ||
      stopLossLineLabelRef.current !== stopLossLabel
    ) {
      if (stopLoss === null) {
        if (stopLossLineRef.current) candleSeries.removePriceLine(stopLossLineRef.current);
        stopLossLineRef.current = null;
      } else if (stopLossLineRef.current) {
        stopLossLineRef.current.applyOptions({
          price: stopLoss,
          title: stopLossLabel,
        });
      } else {
        stopLossLineRef.current = candleSeries.createPriceLine({
          price: stopLoss,
          color: "#ef6572",
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: stopLossLabel,
        });
      }
      stopLossLineValueRef.current = stopLoss;
      stopLossLineLabelRef.current = stopLossLabel;
    }

    const activeLimitOrderIds = new Set(
      limitOrders.map((order) => order.limitOrderId),
    );
    for (const [limitOrderId, line] of limitOrderLineRefs.current) {
      if (activeLimitOrderIds.has(limitOrderId)) continue;
      candleSeries.removePriceLine(line);
      limitOrderLineRefs.current.delete(limitOrderId);
      limitOrderLineSignaturesRef.current.delete(limitOrderId);
    }
    limitOrders.forEach((order) => {
      const color = order.side === "buy" ? "#30c487" : "#ef6572";
      const title = `${order.side === "buy" ? "BUY LIMIT" : "SELL LIMIT"} ${Math.round(order.ratio * 100)}%`;
      const signature = `${order.price}:${color}:${title}`;
      const existingLine = limitOrderLineRefs.current.get(order.limitOrderId);
      if (!existingLine) {
        limitOrderLineRefs.current.set(
          order.limitOrderId,
          candleSeries.createPriceLine({
            price: order.price,
            color,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title,
          }),
        );
        limitOrderLineSignaturesRef.current.set(order.limitOrderId, signature);
      } else if (limitOrderLineSignaturesRef.current.get(order.limitOrderId) !== signature) {
        existingLine.applyOptions({ price: order.price, color, title });
        limitOrderLineSignaturesRef.current.set(order.limitOrderId, signature);
      }
    });
    const viewportKey = `${sessionId}:${timeframe}`;
    if (viewportSessionIdRef.current !== viewportKey) {
      chart.timeScale().setVisibleLogicalRange({
        from: candles.length - TRAINING_MAIN_VISIBLE_CANDLES,
        to: candles.length + 5,
      });
      viewportSessionIdRef.current = viewportKey;
    }
  }, [
    averagePrice,
    candles,
    limitOrders,
    markers,
    ready,
    sessionId,
    stopLoss,
    stopLossLabel,
    takeProfit,
    takeProfitLabel,
    timeframe,
  ]);

  const projectedDrawings = useTrainingDrawingProjection({
    ready,
    timeframe,
    candles,
    drawings,
    dataVersion: `${candles.length}:${candles.at(-1)?.time ?? "empty"}:${candles.at(-1)?.high ?? 0}:${candles.at(-1)?.low ?? 0}`,
    chartRef,
    seriesRef: candleSeriesRef,
    containerRef,
  });

  const handleLimitContextMenu = useCallback((
    event: React.MouseEvent<Element>,
  ) => {
    event.preventDefault();
    if (drawingMode !== "none") return;
    const candleSeries = candleSeriesRef.current;
    const container = containerRef.current;
    if (!canPlaceLimitOrder || !candleSeries || !container) return;
    const bounds = container.getBoundingClientRect();
    const rawPrice = candleSeries.coordinateToPrice(event.clientY - bounds.top);
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    setCancelLimitMenu(null);
    setLimitMenu({
      x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 190)),
      y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 150)),
      price: Number(price.toFixed(2)),
    });
  }, [canPlaceLimitOrder, drawingMode]);

  const getDrawingPointAtClient = useCallback((
    clientX: number,
    clientY: number,
  ): TrainingDrawingPoint | null => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const container = containerRef.current;
    if (!chart || !candleSeries || !container) return null;
    const bounds = container.getBoundingClientRect();
    const x = clientX - bounds.left;
    const rawTime = chart.timeScale().coordinateToTime(x);
    const logicalIndex = chart.timeScale().coordinateToLogical(x);
    const rawPrice = candleSeries.coordinateToPrice(clientY - bounds.top);
    const time = typeof rawTime === "number"
      ? rawTime
      : logicalIndex === null
        ? Number.NaN
        : getTrainingDrawingTimeAtLogicalIndex({
            candles,
            logicalIndex: Number(logicalIndex),
            timeframe,
          });
    const price = Number(rawPrice);
    if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) {
      return null;
    }
    return { time, price };
  }, [candles, timeframe]);

  const getDrawingPoint = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
  ) => getDrawingPointAtClient(event.clientX, event.clientY), [
    getDrawingPointAtClient,
  ]);

  const handleRectanglePointerDown = useCallback((
    event: React.PointerEvent<SVGElement>,
    drawingId: string,
    mode: TrainingRectangleDragMode,
  ) => {
    if (event.button !== 0) return;
    const rectangle = drawings.find(
      (drawing): drawing is Extract<TrainingChartDrawing, { kind: "rectangle" }> =>
        drawing.id === drawingId && drawing.kind === "rectangle",
    );
    const chart = chartRef.current;
    const startPoint = getDrawingPointAtClient(event.clientX, event.clientY);
    if (!rectangle || !chart || !startPoint) return;

    event.preventDefault();
    event.stopPropagation();
    setSelectedDrawingId(drawingId);
    const selectedColor = TRAINING_DRAWING_COLORS.find(
      (option) => option.value === rectangle.color,
    );
    if (selectedColor) setDrawingColor(selectedColor.value);
    setDrawingAnchor(null);
    setDrawingMode("none");
    setLimitMenu(null);
    setCancelLimitMenu(null);
    rectangleDragCleanupRef.current?.();
    chart.applyOptions({ handleScroll: false, handleScale: false });

    const pointerId = event.pointerId;
    const pointerTarget = event.currentTarget;
    pointerTarget.setPointerCapture(pointerId);

    let finished = false;
    let moveFrame: number | null = null;
    let pendingDrawings: TrainingChartDrawing[] | null = null;
    const flushPendingDrawings = () => {
      moveFrame = null;
      if (!pendingDrawings) return;
      const nextDrawings = pendingDrawings;
      pendingDrawings = null;
      onDrawingsChange(nextDrawings);
    };
    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const point = getDrawingPointAtClient(moveEvent.clientX, moveEvent.clientY);
      if (!point) return;
      const nextRectangle = mode === "move"
        ? moveTrainingRectangle(rectangle, {
            timeDelta: point.time - startPoint.time,
            priceDelta: point.price - startPoint.price,
          })
        : resizeTrainingRectangle(rectangle, mode, point);
      pendingDrawings = drawings.map((drawing) =>
        drawing.id === drawingId ? nextRectangle : drawing
      );
      if (moveFrame === null) {
        moveFrame = window.requestAnimationFrame(flushPendingDrawings);
      }
    };
    const cleanup = () => {
      if (moveFrame !== null) {
        window.cancelAnimationFrame(moveFrame);
        moveFrame = null;
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (pointerTarget.hasPointerCapture(pointerId)) {
        pointerTarget.releasePointerCapture(pointerId);
      }
      chart.applyOptions({ handleScroll: true, handleScale: true });
      if (rectangleDragCleanupRef.current === cleanup) {
        rectangleDragCleanupRef.current = null;
      }
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finished || finishEvent.pointerId !== pointerId) return;
      finished = true;
      finishEvent.preventDefault();
      flushPendingDrawings();
      cleanup();
    };

    rectangleDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", finish, { passive: false });
    window.addEventListener("pointercancel", finish, { passive: false });
  }, [drawings, getDrawingPointAtClient, onDrawingsChange]);

  const handleChartPointerDown = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    chartPointerStartRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handleChartClick = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (ignoreNextChartClickRef.current) {
      ignoreNextChartClickRef.current = false;
      return;
    }
    const pointerStart = chartPointerStartRef.current;
    chartPointerStartRef.current = null;
    if (
      pointerStart &&
      Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5
    ) {
      return;
    }

    if (drawingMode !== "none") {
      const point = getDrawingPoint(event);
      if (!point) return;
      drawingSequenceRef.current += 1;
      const drawingId = `${sessionId}-${drawingSequenceRef.current}`;
      if (drawingMode === "horizontal") {
        onDrawingsChange([...drawings, {
          id: drawingId,
          kind: "horizontal",
          price: point.price,
          color: drawingColor,
        }]);
        setSelectedDrawingId(null);
        setDrawingMode("none");
        return;
      }
      if (!drawingAnchor) {
        setDrawingAnchor(point);
        return;
      }
      onDrawingsChange([...drawings, {
        id: drawingId,
        kind: "rectangle",
        startTime: Math.min(drawingAnchor.time, point.time),
        endTime: Math.max(drawingAnchor.time, point.time),
        topPrice: Math.max(drawingAnchor.price, point.price),
        bottomPrice: Math.min(drawingAnchor.price, point.price),
        color: drawingColor,
      }]);
      setSelectedDrawingId(drawingId);
      setDrawingAnchor(null);
      setDrawingMode("none");
      return;
    }

    const candleSeries = candleSeriesRef.current;
    const container = containerRef.current;
    setSelectedDrawingId(null);
    if (!candleSeries || !container || limitOrders.length === 0) return;
    const bounds = container.getBoundingClientRect();
    const localY = event.clientY - bounds.top;
    const nearest = limitOrders.reduce<{
      order: TrainingLimitOrder;
      distance: number;
    } | null>((candidate, order) => {
      const coordinate = candleSeries.priceToCoordinate(order.price);
      if (coordinate === null) return candidate;
      const distance = Math.abs(coordinate - localY);
      if (distance > 10 || (candidate && candidate.distance <= distance)) {
        return candidate;
      }
      return { order, distance };
    }, null);
    if (!nearest) return;
    event.preventDefault();
    event.stopPropagation();
    setLimitMenu(null);
    setCancelLimitMenu({
      x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 190)),
      y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 104)),
      order: nearest.order,
    });
  }, [
    drawingAnchor,
    drawingColor,
    drawingMode,
    drawings,
    getDrawingPoint,
    limitOrders,
    onDrawingsChange,
    sessionId,
  ]);

  useEffect(() => {
    if (!limitMenu && !cancelLimitMenu && drawingMode === "none") return;
    const closeMenus = () => {
      setLimitMenu(null);
      setCancelLimitMenu(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMenus();
      setDrawingAnchor(null);
      setDrawingMode("none");
    };
    window.addEventListener("pointerdown", closeMenus);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", closeMenus);
      window.removeEventListener("keydown", handleKey);
    };
  }, [cancelLimitMenu, drawingMode, limitMenu]);

  useEffect(() => {
    if (
      cancelLimitMenu &&
      !limitOrders.some(
        (order) => order.limitOrderId === cancelLimitMenu.order.limitOrderId,
      )
    ) {
      setCancelLimitMenu(null);
    }
  }, [cancelLimitMenu, limitOrders]);

  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (
      !ready ||
      !container ||
      !chart ||
      !candleSeries ||
      averagePrice === null ||
      positionSide === null ||
      drawingMode !== "none"
    ) {
      return;
    }

    let activePointerId: number | null = null;
    let pendingPrice: number | null = null;
    let pendingKind: TrainingRiskKind | null = null;

    const localY = (event: PointerEvent) =>
      event.clientY - container.getBoundingClientRect().top;
    const isNearCostLine = (event: PointerEvent) => {
      const costCoordinate = candleSeries.priceToCoordinate(averagePrice);
      if (costCoordinate === null) return false;
      const threshold = event.pointerType === "touch" ? 22 : 11;
      return Math.abs(localY(event) - costCoordinate) <= threshold;
    };
    const clearPreview = () => {
      if (previewLineRef.current) {
        candleSeries.removePriceLine(previewLineRef.current);
        previewLineRef.current = null;
      }
      pendingPrice = null;
      pendingKind = null;
    };
    const updatePreview = (event: PointerEvent) => {
      const rawPrice = candleSeries.coordinateToPrice(localY(event));
      const price = Number(rawPrice);
      const kind = classifyTrainingRiskPrice(
        positionSide,
        averagePrice,
        price,
      );
      if (kind === null) {
        clearPreview();
        return;
      }

      pendingPrice = Number(price.toFixed(2));
      pendingKind = kind;
      const color = kind === "takeProfit" ? "#30c487" : "#ef6572";
      const title = kind === "takeProfit" ? "TP" : "SL";
      if (previewLineRef.current) {
        previewLineRef.current.applyOptions({
          price: pendingPrice,
          color,
          title,
        });
      } else {
        previewLineRef.current = candleSeries.createPriceLine({
          price: pendingPrice,
          color,
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title,
        });
      }
    };
    const stopNativeChartGesture = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const finishDrag = (event: PointerEvent, commit: boolean) => {
      if (event.pointerId !== activePointerId) return;
      stopNativeChartGesture(event);
      const selectedPrice = pendingPrice;
      const selectedKind = pendingKind;
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      activePointerId = null;
      container.classList.remove(styles.riskDragging, styles.riskDragReady);
      chart.applyOptions({ handleScroll: true, handleScale: true });
      clearPreview();
      if (commit && selectedKind !== null && selectedPrice !== null) {
        onRiskPriceChange(selectedKind, selectedPrice);
      }
      window.setTimeout(() => {
        ignoreNextChartClickRef.current = false;
      }, 0);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!isNearCostLine(event)) return;
      stopNativeChartGesture(event);
      activePointerId = event.pointerId;
      ignoreNextChartClickRef.current = true;
      container.setPointerCapture(event.pointerId);
      container.classList.remove(styles.riskDragReady);
      container.classList.add(styles.riskDragging);
      chart.applyOptions({ handleScroll: false, handleScale: false });
      updatePreview(event);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (activePointerId === null) {
        container.classList.toggle(styles.riskDragReady, isNearCostLine(event));
        return;
      }
      if (event.pointerId !== activePointerId) return;
      stopNativeChartGesture(event);
      updatePreview(event);
    };
    const handlePointerUp = (event: PointerEvent) => finishDrag(event, true);
    const handlePointerCancel = (event: PointerEvent) => finishDrag(event, false);
    const handlePointerLeave = () => {
      if (activePointerId === null) {
        container.classList.remove(styles.riskDragReady);
      }
    };

    container.addEventListener("pointerdown", handlePointerDown, true);
    container.addEventListener("pointermove", handlePointerMove, true);
    container.addEventListener("pointerup", handlePointerUp, true);
    container.addEventListener("pointercancel", handlePointerCancel, true);
    container.addEventListener("pointerleave", handlePointerLeave, true);
    return () => {
      container.removeEventListener("pointerdown", handlePointerDown, true);
      container.removeEventListener("pointermove", handlePointerMove, true);
      container.removeEventListener("pointerup", handlePointerUp, true);
      container.removeEventListener("pointercancel", handlePointerCancel, true);
      container.removeEventListener("pointerleave", handlePointerLeave, true);
      container.classList.remove(styles.riskDragging, styles.riskDragReady);
      if (activePointerId !== null) {
        chart.applyOptions({ handleScroll: true, handleScale: true });
      }
      clearPreview();
    };
  }, [averagePrice, drawingMode, onRiskPriceChange, positionSide, ready]);

  const last = candles.at(-1);
  return (
    <div
      className={styles.trainingChart}
      role="img"
      aria-label={last
        ? `BTCUSDT 训练 K 线，当前显示 ${candles.length} 根，最新价格 ${formatPrice(last.close)}，未来行情已隐藏`
        : "BTCUSDT 训练 K 线尚未载入"}
    >
      <div
        ref={containerRef}
        className={`${styles.chartCanvas} ${drawingMode !== "none" ? styles.drawingActive : ""}`}
        aria-hidden="true"
        onPointerDown={handleChartPointerDown}
        onClick={handleChartClick}
        onContextMenu={handleLimitContextMenu}
      />
      <TrainingDrawingOverlay
        className={styles.drawingOverlay}
        drawings={projectedDrawings}
        interactive={drawingMode === "none"}
        selectedDrawingId={selectedDrawingId}
        onRectanglePointerDown={handleRectanglePointerDown}
        onContextMenu={handleLimitContextMenu}
      />
      <div
        className={styles.drawingToolbar}
        role="toolbar"
        aria-label="训练绘图工具"
      >
        <button
          type="button"
          className={drawingMode === "horizontal" ? styles.activeTool : ""}
          aria-pressed={drawingMode === "horizontal"}
          onClick={() => {
            setDrawingAnchor(null);
            setSelectedDrawingId(null);
            setDrawingMode((current) => current === "horizontal" ? "none" : "horizontal");
          }}
        >
          水平线
        </button>
        <button
          type="button"
          className={drawingMode === "rectangle" ? styles.activeTool : ""}
          aria-pressed={drawingMode === "rectangle"}
          onClick={() => {
            setDrawingAnchor(null);
            setSelectedDrawingId(null);
            setDrawingMode((current) => current === "rectangle" ? "none" : "rectangle");
          }}
        >
          矩形框
        </button>
        <div className={styles.drawingColorChoices} role="group" aria-label="绘图颜色">
          {TRAINING_DRAWING_COLORS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.drawingColorSwatch} ${drawingColor === option.value ? styles.activeColor : ""}`}
              style={{ backgroundColor: option.value }}
              aria-label={option.label}
              aria-pressed={drawingColor === option.value}
              title={option.label}
              onClick={() => {
                setDrawingColor(option.value);
                if (selectedDrawingId) {
                  onDrawingsChange(drawings.map((drawing) =>
                    drawing.id === selectedDrawingId
                      ? { ...drawing, color: option.value }
                      : drawing
                  ));
                }
              }}
            />
          ))}
        </div>
        <button
          type="button"
          disabled={!drawingAnchor && drawings.length === 0}
          onClick={() => {
            setDrawingAnchor(null);
            setSelectedDrawingId(null);
            onDrawingsChange([]);
          }}
        >
          清空绘图
        </button>
        {drawingAnchor && <span>选择矩形终点</span>}
      </div>
      {limitMenu && (
        <div
          className={styles.limitOrderMenu}
          style={{ left: limitMenu.x, top: limitMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          role="dialog"
          aria-label="设置限价单"
        >
          <strong>限价 {formatPrice(limitMenu.price)}</strong>
          <div>
            {([0.1, 0.25, 0.5, 1] as OrderRatio[]).map((value) => (
              <button
                type="button"
                key={value}
                className={limitRatio === value ? styles.active : ""}
                onClick={() => setLimitRatio(value)}
              >
                {Math.round(value * 100)}%
              </button>
            ))}
          </div>
          <div>
            <button
              type="button"
              className={styles.buyButton}
              onClick={() => {
                onPlaceLimitOrder("buy", limitMenu.price, limitRatio);
                setLimitMenu(null);
              }}
            >
              BUY LIMIT
            </button>
            <button
              type="button"
              className={styles.sellButton}
              onClick={() => {
                onPlaceLimitOrder("sell", limitMenu.price, limitRatio);
                setLimitMenu(null);
              }}
            >
              SELL LIMIT
            </button>
          </div>
        </div>
      )}
      {cancelLimitMenu && (
        <div
          className={styles.limitCancelMenu}
          style={{ left: cancelLimitMenu.x, top: cancelLimitMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          role="dialog"
          aria-label="取消限价单"
        >
          <strong>
            {cancelLimitMenu.order.side === "buy" ? "BUY" : "SELL"} LIMIT ·{" "}
            {formatPrice(cancelLimitMenu.order.price)}
          </strong>
          <button
            type="button"
            onClick={() => {
              onCancelLimitOrder(cancelLimitMenu.order.limitOrderId);
              setCancelLimitMenu(null);
            }}
          >
            取消该限价单
          </button>
          <button type="button" onClick={() => setCancelLimitMenu(null)}>
            保留
          </button>
        </div>
      )}
      {!ready && <div className={styles.chartPlaceholder}>正在准备训练图表…</div>}
      <div className={styles.xinIndicatorBadge}>XIN Mentorship · WT / Momentum / MFI</div>
    </div>
  );
}

type TrainingAuditRecord = {
  actions?: readonly TrainingActionRecord[];
  riskChanges?: readonly TrainingRiskChangeRecord[];
  limitOrderChanges?: readonly TrainingLimitOrderChangeRecord[];
};

type TrainingOperationRow =
  | {
      kind: "trade";
      key: string;
      order: number;
      action: TrainingActionRecord;
      marker?: TrainingMarker;
    }
  | {
      kind: "risk";
      key: string;
      order: number;
      change: TrainingRiskChangeRecord;
    }
  | {
      kind: "limit";
      key: string;
      order: number;
      change: TrainingLimitOrderChangeRecord;
    }
  | {
      kind: "legacy-marker";
      key: string;
      order: number;
      marker: TrainingMarker;
    };

function describeTrainingAction(action: TrainingActionRecord) {
  const positionName = action.side === "long" ? "多" : "空";
  if (action.automatic) {
    if (action.trigger === "limitOrder") {
      if (action.type === "open") {
        return action.side === "long" ? "BUY LIMIT 开多" : "SELL LIMIT 开空";
      }
      if (action.type === "add") {
        return action.side === "long" ? "BUY LIMIT 加多" : "SELL LIMIT 加空";
      }
      if (action.type === "reduce") {
        return action.side === "long" ? "SELL LIMIT 减多" : "BUY LIMIT 减空";
      }
      return action.side === "long" ? "SELL LIMIT 平多" : "BUY LIMIT 平空";
    }
    return `${action.trigger === "takeProfit" ? "TP" : "SL"} 自动平${positionName}`;
  }
  if (action.type === "open") return action.side === "long" ? "BUY 开多" : "SELL 开空";
  if (action.type === "add") return action.side === "long" ? "BUY 加多" : "SELL 加空";
  if (action.type === "reduce") return action.side === "long" ? "SELL 减多" : "BUY 减空";
  return action.side === "long" ? "SELL 平多" : "BUY 平空";
}

function isBuyTrainingAction(action: TrainingActionRecord) {
  const entersPosition = action.type === "open" || action.type === "add";
  return action.side === "long" ? entersPosition : !entersPosition;
}

function formatRiskLevel(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : formatPrice(value);
}

function TrainingPositionValue({ position }: { position: TrainingPosition | null }) {
  if (!position) return <span className={styles.emptyValue}>空仓</span>;
  return (
    <div className={styles.positionValue}>
      <strong>{formatBtcQuantity(position.quantity)}</strong>
      <small>
        {position.side === "long" ? "LONG" : "SHORT"} · 成本 {formatPrice(position.averagePrice)}
        {" · "}保证金 {formatMoney(position.margin)}
      </small>
    </div>
  );
}

function TrainingOperationTime({
  marketLocation,
  recordedAt,
  marker,
}: {
  marketLocation?: TrainingMarketLocation;
  recordedAt?: string;
  marker?: TrainingMarker;
}) {
  const marketTime = marketLocation
    ? marketLocation.timing === "candle-close"
      ? marketLocation.candleCloseTimeMs
      : marketLocation.candleOpenTimeMs
    : marker
      ? marker.time * 1000
      : null;
  return (
    <div className={styles.operationTime}>
      <strong>{marketTime === null ? "旧记录未保存行情位置" : formatDateTime(marketTime)}</strong>
      {marketLocation ? (
        <>
          <small>
            K线 #{marketLocation.candleIndex + 1} · 训练起点
            {marketLocation.revealedOffset === 0 ? "当根" : ` +${marketLocation.revealedOffset}`}
          </small>
          <small>
            {marketLocation.timing === "intrabar-unknown"
              ? "本根 K 线内触发，精确秒数未知"
              : "按本根 K 线收盘价执行"}
          </small>
        </>
      ) : marker ? (
        <small>旧图表标记 · K线索引未保存</small>
      ) : null}
      <small>现实记录 {recordedAt ? formatDateTime(recordedAt) : "未保存"}</small>
    </div>
  );
}

function TrainingOperationTable({
  record,
  markers = [],
}: {
  record: TrainingAuditRecord;
  markers?: readonly TrainingMarker[];
}) {
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const riskChanges = Array.isArray(record.riskChanges) ? record.riskChanges : [];
  const limitOrderChanges = Array.isArray(record.limitOrderChanges)
    ? record.limitOrderChanges
    : [];
  const rows: TrainingOperationRow[] = actions.map((action, index) => {
    const marker = markers.find((item) =>
      Boolean(action.actionId) && item.actionId === action.actionId,
    ) ?? markers[action.sequence - 1];
    return {
      kind: "trade",
      key: action.actionId || `legacy-action-${action.sequence}-${index}`,
      order: Number.isFinite(action.operationSequence)
        ? action.operationSequence
        : action.sequence * 2,
      action,
      marker,
    };
  });
  rows.push(...riskChanges.map((change, index) => ({
    kind: "risk" as const,
    key: change.riskChangeId || `legacy-risk-${change.sequence}-${index}`,
    order: Number.isFinite(change.operationSequence)
      ? change.operationSequence
      : change.sequence * 2 + 1,
    change,
  })));
  rows.push(...limitOrderChanges.map((change, index) => ({
    kind: "limit" as const,
    key: change.limitOrderChangeId ||
      `legacy-limit-${change.sequence}-${index}`,
    order: Number.isFinite(change.operationSequence)
      ? change.operationSequence
      : change.sequence * 3 + 2,
    change,
  })));
  if (
    actions.length === 0 &&
    riskChanges.length === 0 &&
    limitOrderChanges.length === 0
  ) {
    rows.push(...markers.map((marker, index) => ({
      kind: "legacy-marker" as const,
      key: marker.id,
      order: index + 1,
      marker,
    })));
  }
  rows.sort((left, right) => left.order - right.order);

  if (rows.length === 0) {
    return <div className={styles.emptyOperations}>本局还没有仓位或风控操作</div>;
  }

  return (
    <div className={styles.operationTableWrap}>
      <table className={styles.operationTable}>
        <thead>
          <tr>
            <th>#</th>
            <th>行情时间 / K线</th>
            <th>操作</th>
            <th>成交 / 风控价格</th>
            <th>本次数量</th>
            <th>操作前仓位</th>
            <th>操作后仓位</th>
            <th>本次保证金</th>
            <th>本次 / 累计盈亏</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            if (row.kind === "legacy-marker") {
              return (
                <tr key={row.key}>
                  <td>{index + 1}</td>
                  <td>
                    <TrainingOperationTime marker={row.marker} />
                  </td>
                  <td>
                    <div className={styles.operationKind}>
                      <i className={row.marker.direction === "buy" ? styles.buyDot : styles.sellDot} />
                      <strong>{row.marker.label}</strong>
                      <small>旧版图表标记</small>
                    </div>
                  </td>
                  <td>{formatPrice(row.marker.price)}</td>
                  <td colSpan={5} className={styles.legacyOperationNote}>
                    旧记录未保存数量、仓位与盈亏快照
                  </td>
                </tr>
              );
            }

            if (row.kind === "risk") {
              const { change } = row;
              const cleared = change.after === null;
              return (
                <tr key={row.key}>
                  <td>{change.operationSequence ?? index + 1}</td>
                  <td>
                    <TrainingOperationTime
                      marketLocation={change.marketLocation}
                      recordedAt={change.recordedAt ?? change.time}
                    />
                  </td>
                  <td>
                    <div className={styles.operationKind}>
                      <i className={styles.riskDot} />
                      <strong>{cleared ? "清除 TP / SL" : "调整 TP / SL"}</strong>
                      <small>{change.source === "drag" ? "拖动成本线" : change.source === "input" ? "价格输入" : "旧记录"}</small>
                    </div>
                  </td>
                  <td>
                    <div className={styles.riskValue}>
                      <strong>TP {formatRiskLevel(change.after?.takeProfit)}</strong>
                      <small>SL {formatRiskLevel(change.after?.stopLoss)}</small>
                    </div>
                  </td>
                  <td>—</td>
                  <td><TrainingPositionValue position={change.position} /></td>
                  <td><TrainingPositionValue position={change.position} /></td>
                  <td>{formatMoney(change.position.margin)}</td>
                  <td>—</td>
                </tr>
              );
            }

            if (row.kind === "limit") {
              const { change } = row;
              const operationLabel = change.type === "place"
                ? "创建限价单"
                : change.type === "cancel"
                  ? "撤销限价单"
                  : "限价单触发";
              return (
                <tr key={row.key}>
                  <td>{change.operationSequence ?? index + 1}</td>
                  <td>
                    <TrainingOperationTime
                      marketLocation={change.marketLocation}
                      recordedAt={change.recordedAt ?? change.time}
                    />
                  </td>
                  <td>
                    <div className={styles.operationKind}>
                      <i className={change.order.side === "buy" ? styles.buyDot : styles.sellDot} />
                      <strong>{operationLabel}</strong>
                      <small>
                        {change.order.side.toUpperCase()} LIMIT ·
                        {" "}{Math.round(change.order.ratio * 100)}%
                      </small>
                    </div>
                  </td>
                  <td>{formatPrice(change.order.price)}</td>
                  <td>{Math.round(change.order.ratio * 100)}%</td>
                  <td colSpan={4} className={styles.legacyOperationNote}>
                    {change.reason === "position-changed"
                      ? "仓位变化后订单意图失效，系统自动撤销"
                      : `订单用途：${change.order.intent}`}
                  </td>
                </tr>
              );
            }

            const { action } = row;
            const buy = isBuyTrainingAction(action);
            return (
              <tr key={row.key}>
                <td>{action.operationSequence ?? action.sequence}</td>
                <td>
                  <TrainingOperationTime
                    marketLocation={action.marketLocation}
                    recordedAt={action.recordedAt ?? action.time}
                    marker={row.marker}
                  />
                </td>
                <td>
                  <div className={styles.operationKind}>
                    <i className={buy ? styles.buyDot : styles.sellDot} />
                    <strong>{describeTrainingAction(action)}</strong>
                    <small>{action.automatic ? "自动触发" : "手动成交"}</small>
                  </div>
                </td>
                <td>{formatPrice(action.price)}</td>
                <td>{formatBtcQuantity(action.quantity)}</td>
                <td><TrainingPositionValue position={action.positionBefore} /></td>
                <td><TrainingPositionValue position={action.positionAfter} /></td>
                <td>{formatMoney(action.margin)}</td>
                <td className={action.realizedPnl >= 0 ? styles.profitText : styles.lossText}>
                  <div className={styles.pnlValue}>
                    <strong>{formatMoney(action.realizedPnl, true)}</strong>
                    <small>累计 {formatMoney(action.totalRealizedPnl, true)}</small>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrainingSummaryCard({ record }: { record: TrainingResultRecord }) {
  const summary = record.summary;
  if (!summary) return null;
  const pnlClass = summary.netPnl >= 0 ? styles.profitText : styles.lossText;
  return (
    <section className={styles.trainingSummaryCard} aria-label="本局训练总结">
      <div className={styles.performanceHeading}>
        <div>
          <strong>本局训练总结</strong>
          <span>{summary.mainTimeframe} 主图 · {summary.holdingCycleCount} 个持仓周期</span>
        </div>
        <em className={pnlClass}>{formatMoney(summary.netPnl, true)}</em>
      </div>
      <div className={styles.trainingSummaryMetrics}>
        <article>
          <span>本局盈利</span>
          <strong className={pnlClass}>{formatMoney(summary.netPnl, true)}</strong>
        </article>
        <article>
          <span>收益率</span>
          <strong className={pnlClass}>{formatPercent(summary.returnRatePercent, true)}</strong>
        </article>
        <article>
          <span>R 倍数</span>
          <strong>{formatRMultiple(summary.rMultiple)}</strong>
          <small>{summary.initialRisk === null
            ? "本局未设置完整初始止损"
            : `初始风险 ${formatMoney(summary.initialRisk)}`}</small>
        </article>
        <article>
          <span>最大浮盈 MFE</span>
          <strong className={styles.profitText}>{formatMoney(summary.mfe, true)}</strong>
        </article>
        <article>
          <span>最大浮亏 MAE</span>
          <strong className={styles.lossText}>{formatMoney(summary.mae, true)}</strong>
        </article>
        <article>
          <span>平均持仓 K 线</span>
          <strong>{summary.averageHoldingBars.toFixed(1)} 根</strong>
          <small>{formatTrainingDuration(summary.averageHoldingMs)}</small>
        </article>
        <article>
          <span>加仓次数</span>
          <strong>{summary.addCount}</strong>
        </article>
        <article>
          <span>减仓次数</span>
          <strong>{summary.reduceCount}</strong>
        </article>
      </div>
      <small className={styles.trainingSummaryNote}>
        MFE 与 MAE 根据已揭示 K 线高低价及当时仓位估算；没有为每个持仓周期设置初始止损时不计算 R。
      </small>
    </section>
  );
}

function TrainingPerformanceBoard({
  results,
  onResultsChange,
}: {
  results: TrainingResultRecord[];
  onResultsChange: (results: TrainingResultRecord[]) => void;
}) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [archiveNotice, setArchiveNotice] = useState("");
  const performance = useMemo(() => calculateTrainingPerformance(results), [results]);
  const analyticsPerformance = useMemo(
    () => calculateTrainingAnalyticsPerformance(results),
    [results],
  );
  const sortedResults = useMemo(
    () => [...results].sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt)),
    [results],
  );
  const curve = performance.cumulativeCurve;
  const width = 720;
  const height = 220;
  const padding = { left: 58, right: 18, top: 18, bottom: 32 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = [0, ...curve.map((point) => point.cumulativePnl)];
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  if (minimum === maximum) {
    minimum -= 1;
    maximum += 1;
  }
  const toY = (value: number) =>
    padding.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const points = curve.map((point, index) => ({
    ...point,
    x: curve.length === 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (curve.length - 1)) * plotWidth,
    y: toY(point.cumulativePnl),
  }));
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");

  const exportRecords = useCallback(() => {
    if (results.length === 0) return;
    try {
      const contents = serializeTrainingResultsExport(results);
      const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
      const downloadUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `cryptoreview-training-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(downloadUrl);
      setArchiveNotice(`已导出 ${results.length} 条训练记录`);
    } catch (error) {
      setArchiveNotice(error instanceof Error ? error.message : "训练记录导出失败");
    }
  }, [results]);

  const importRecords = useCallback(async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > TRAINING_IMPORT_MAX_BYTES) {
        throw new RangeError("训练记录文件不能超过 25 MB");
      }
      const imported = parseTrainingResultsImport(
        await file.text(),
      ) as unknown as TrainingResultRecord[];
      const merged = mergeTrainingResultRecords(
        results,
        imported,
      ) as unknown as TrainingResultRecord[];
      onResultsChange(merged);
      setArchiveNotice(
        `已导入 ${imported.length} 条训练记录，合并后共 ${merged.length} 条`,
      );
    } catch (error) {
      setArchiveNotice(error instanceof Error ? error.message : "训练记录导入失败");
    } finally {
      input.value = "";
    }
  }, [onResultsChange, results]);

  const clearRecords = useCallback(() => {
    if (results.length === 0) return;
    const confirmed = window.confirm(
      `确定清空全部 ${results.length} 条已完成训练记录吗？当前正在进行的训练不会受影响，此操作无法撤销。`,
    );
    if (!confirmed) return;
    onResultsChange([]);
    setArchiveNotice("已清空全部已完成训练记录");
  }, [onResultsChange, results.length]);

  const recordTools = (
    <>
      <article className={styles.trainingRecordTools} aria-label="训练记录管理">
        <div>
          <strong>训练记录管理</strong>
          <span>JSON 文件仅包含已完成训练，不包含真实交易或 API 凭证。</span>
        </div>
        <div className={styles.trainingRecordActions}>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(event) => void importRecords(event)}
            hidden
            aria-label="选择 CryptoReview 训练记录 JSON"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
          >
            <FileUp size={14} />导入记录
          </button>
          <button
            type="button"
            onClick={exportRecords}
            disabled={results.length === 0}
          >
            <Download size={14} />导出记录
          </button>
          <button
            type="button"
            className={styles.clearTrainingRecords}
            onClick={clearRecords}
            disabled={results.length === 0}
          >
            <Trash2 size={14} />清空记录
          </button>
        </div>
      </article>
      {archiveNotice && (
        <div className={styles.trainingArchiveNotice} role="status">
          {archiveNotice}
        </div>
      )}
    </>
  );

  if (results.length === 0) {
    return (
      <section className={styles.performanceBoard} aria-label="训练表现看板">
        {recordTools}
        <div className={styles.emptyPerformance}>
          <BarChart3 size={28} />
          <strong>还没有完成的训练</strong>
          <span>完成第一局 BTC 行情训练后，这里会单独统计训练成绩。</span>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.performanceBoard} aria-label="训练表现看板">
      {recordTools}
      <div className={styles.performanceMetrics}>
        <article>
          <span>累计训练盈亏</span>
          <strong className={performance.totalPnl >= 0 ? styles.profitText : styles.lossText}>
            {formatMoney(performance.totalPnl, true)}
          </strong>
          <small>{performance.totalSessions} 局已完成</small>
        </article>
        <article>
          <span>胜率</span>
          <strong>{performance.winRate.toFixed(1)}%</strong>
          <small>{performance.wins} 胜 · {performance.losses} 负</small>
        </article>
        <article>
          <span>平均盈亏比</span>
          <strong>{performance.averageProfitLossRatio === null
            ? "—"
            : `${performance.averageProfitLossRatio.toFixed(2)} : 1`}</strong>
          <small>仅统计已结束训练</small>
        </article>
      </div>

      <div className={styles.performanceAdvancedMetrics}>
        <article>
          <span>平均 R</span>
          <strong>{formatRMultiple(analyticsPerformance.averageR)}</strong>
          <small>{analyticsPerformance.rSampleSize} 局建立了完整 R 基准</small>
        </article>
        <article>
          <span>最大回撤</span>
          <strong className={styles.lossText}>{formatMoney(-analyticsPerformance.maxDrawdown)}</strong>
          <small>按训练累计盈亏曲线计算</small>
        </article>
        <article>
          <span>最大连续盈利</span>
          <strong>{analyticsPerformance.maxConsecutiveWins} 局</strong>
        </article>
        <article>
          <span>最大连续亏损</span>
          <strong>{analyticsPerformance.maxConsecutiveLosses} 局</strong>
        </article>
        <article>
          <span>平均持仓时间</span>
          <strong>{formatTrainingDuration(analyticsPerformance.averageHoldingMs)}</strong>
        </article>
        <article>
          <span>平均最大浮亏</span>
          <strong className={styles.lossText}>{analyticsPerformance.averageMae === null
            ? "—"
            : formatMoney(-analyticsPerformance.averageMae)}</strong>
          <small>基于带分析摘要的训练局</small>
        </article>
      </div>

      <article className={styles.performanceChartCard}>
        <div className={styles.performanceHeading}>
          <div>
            <strong>训练累计盈利曲线</strong>
            <span>每局训练结束后的累计结果</span>
          </div>
          <em className={performance.totalPnl >= 0 ? styles.profitText : styles.lossText}>
            {formatMoney(performance.totalPnl, true)}
          </em>
        </div>
        <svg
          className={styles.performanceCurve}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`共 ${performance.totalSessions} 局训练，累计盈亏 ${formatMoney(performance.totalPnl, true)}`}
        >
          <line x1={padding.left} y1={toY(0)} x2={width - padding.right} y2={toY(0)} />
          {points.length > 1 && <polyline points={polyline} />}
          {points.map((point) => (
            <circle key={point.sessionId} cx={point.x} cy={point.y} r="4">
              <title>{point.date} · 本局 {formatMoney(point.pnl, true)} · 累计 {formatMoney(point.cumulativePnl, true)}</title>
            </circle>
          ))}
          <text x={padding.left - 8} y={padding.top + 4} textAnchor="end">{formatMoney(maximum, true).replace(" USDT", "")}</text>
          <text x={padding.left - 8} y={toY(0) + 4} textAnchor="end">0</text>
          <text x={padding.left - 8} y={padding.top + plotHeight} textAnchor="end">{formatMoney(minimum, true).replace(" USDT", "")}</text>
        </svg>
      </article>

      <PerformanceDistributionCharts
        bins={performance.profitPercentDistribution}
        averageWinHoldingMs={performance.averageWinHoldingMs}
        averageLossHoldingMs={performance.averageLossHoldingMs}
        winHoldingSamples={performance.winHoldingSamples}
        lossHoldingSamples={performance.lossHoldingSamples}
        itemLabel="训练"
      />

      <div className={styles.performanceBreakdown}>
        <article>
          <div className={styles.performanceHeading}>
            <div>
              <strong>方向表现</strong>
              <span>分别统计纯做多与纯做空训练局</span>
            </div>
          </div>
          <table className={styles.performanceTable}>
            <thead>
              <tr><th>方向</th><th>局数</th><th>胜率</th><th>平均 R</th><th>盈亏</th></tr>
            </thead>
            <tbody>
              {([
                ["做多", analyticsPerformance.directionStats.long],
                ["做空", analyticsPerformance.directionStats.short],
              ] as const).map(([label, stats]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{stats.sessions}</td>
                  <td>{stats.winRate.toFixed(1)}%</td>
                  <td>{formatRMultiple(stats.averageR)}</td>
                  <td className={stats.totalPnl >= 0 ? styles.profitText : styles.lossText}>
                    {formatMoney(stats.totalPnl, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
        <article>
          <div className={styles.performanceHeading}>
            <div>
              <strong>时间框架表现</strong>
              <span>按训练结束时所使用的主图周期统计</span>
            </div>
          </div>
          <table className={styles.performanceTable}>
            <thead>
              <tr><th>周期</th><th>局数</th><th>胜率</th><th>平均 R</th><th>盈亏</th></tr>
            </thead>
            <tbody>
              {(Object.keys(TRAINING_MAIN_TIMEFRAME_LABELS) as TrainingMainTimeframe[])
                .map((timeframe) => {
                  const stats = analyticsPerformance.timeframeStats[timeframe];
                  return (
                    <tr key={timeframe}>
                      <td>{timeframe}</td>
                      <td>{stats.sessions}</td>
                      <td>{stats.winRate.toFixed(1)}%</td>
                      <td>{formatRMultiple(stats.averageR)}</td>
                      <td className={stats.totalPnl >= 0 ? styles.profitText : styles.lossText}>
                        {formatMoney(stats.totalPnl, true)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </article>
      </div>

      <article className={styles.sessionHistory}>
        <div className={styles.performanceHeading}>
          <div>
            <strong>训练记录</strong>
            <span>与真实交易复盘完全分开</span>
          </div>
        </div>
        <div className={styles.sessionTableWrap}>
          <table>
            <thead>
              <tr>
                <th>完成时间</th>
                <th>周期</th>
                <th>操作</th>
                <th>查看 K 线</th>
                <th>收益率</th>
                <th>盈亏</th>
              </tr>
            </thead>
            <tbody>
              {sortedResults.map((result) => (
                  <tr key={result.id}>
                    <td>{formatDateTime(result.endedAt)}</td>
                    <td>{result.summary?.mainTimeframe ?? result.mainTimeframe ??
                      INTERVAL_LABELS[result.interval] ?? result.interval}</td>
                    <td>
                      {(Array.isArray(result.actions) ? result.actions.length : 0) +
                        (Array.isArray(result.riskChanges) ? result.riskChanges.length : 0) +
                        (Array.isArray(result.limitOrderChanges) ? result.limitOrderChanges.length : 0)} 次
                    </td>
                    <td>{result.barsViewed} 根</td>
                    <td className={result.returnRatePercent >= 0 ? styles.profitText : styles.lossText}>
                      {formatPercent(result.returnRatePercent, true)}
                    </td>
                    <td className={result.netPnl >= 0 ? styles.profitText : styles.lossText}>
                      {formatMoney(result.netPnl, true)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className={styles.sessionAuditArchive} aria-label="历史操作明细">
          <strong>历史操作明细</strong>
          <span>展开任意一局，可查看开仓、加减仓、平仓及 TP / SL 修改位置。</span>
          {sortedResults.map((result) => {
            const operationCount =
              (Array.isArray(result.actions) ? result.actions.length : 0) +
              (Array.isArray(result.riskChanges) ? result.riskChanges.length : 0) +
              (Array.isArray(result.limitOrderChanges) ? result.limitOrderChanges.length : 0);
            return (
              <details key={`${result.id}-audit`}>
                <summary>
                  <span>{formatDateTime(result.endedAt)} · {result.symbol}</span>
                  <strong>
                    {operationCount} 次操作 · {formatMoney(result.netPnl, true)}
                  </strong>
                </summary>
                <TrainingOperationTable
                  record={result}
                  markers={Array.isArray(result.markers) ? result.markers : []}
                />
              </details>
            );
          })}
        </div>
      </article>
    </section>
  );
}

export function TrainingMode({ trainingResults, onResultsChange }: TrainingModeProps) {
  const [view, setView] = useState<TrainingView>("trade");
  const [mainTimeframe, setMainTimeframe] = useState<TrainingMainTimeframe>("15m");
  const [ratio, setRatio] = useState<OrderRatio>(0.25);
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [cursor, setCursor] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [context, setContext] = useState<TrainingContext | null>(null);
  const [markers, setMarkers] = useState<TrainingMarker[]>([]);
  const [drawings, setDrawings] = useState<TrainingChartDrawing[]>([]);
  const [lastResult, setLastResult] = useState<TrainingResultRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const workspaceRef = useRef<HTMLElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const continuationControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    continuationControllerRef.current?.abort();
  }, []);

  const currentCandle = candles[cursor];
  const atLoadedEnd = Boolean(
    session && candles.length > 0 && cursor >= candles.length - 1,
  );
  const canStartNewRound = canStartNewTrainingRound(session);
  const visibleCandles = useMemo(
    () => candles.slice(0, Math.min(cursor + 1, candles.length)),
    [candles, cursor],
  );
  const timeframeAggregator = useMemo(
    () => candles.length > 0 ? createReplayTimeframeAggregator(candles) : null,
    [candles],
  );
  const timeframes = useMemo(() => {
    if (!timeframeAggregator || !currentCandle) {
      return { "1H": [], "4H": [], "1D": [] } satisfies Record<
        Exclude<TrainingMainTimeframe, "15m">,
        MarketCandle[]
      >;
    }
    const aggregated = timeframeAggregator.build({
      cursor,
      replayTimeMs: currentCandle.closeTime,
      currentCandle,
    });
    return {
      "1H": aggregated["1H"],
      "4H": aggregated["4H"],
      "1D": aggregated["1D"],
    };
  }, [currentCandle, cursor, timeframeAggregator]);
  const mainChartCandles = mainTimeframe === "15m"
    ? visibleCandles
    : timeframes[mainTimeframe];
  const mainCurrentCandle = mainChartCandles.at(-1);
  const snapshot = useMemo(() => {
    if (!session || !currentCandle) return null;
    return getTrainingAccountSnapshot(session, currentCandle.close);
  }, [currentCandle, session]);

  const startTraining = useCallback(async () => {
    requestControllerRef.current?.abort();
    continuationControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setNotice("");
    setLastResult(null);
    setDrawings([]);

    try {
      const request = createRandomTrainingRequest({
        interval: TRAINING_MAIN_INTERVAL,
        limit: TRAINING_REQUEST_PAGE_SIZE,
        historyCandles: TRAINING_REQUIRED_CANDLES,
        random: randomUnit(),
      });
      const pages: unknown[] = [];
      let nextRequest = request;
      let mergedPayload: ReturnType<typeof mergeTrainingHistoryPages> | null = null;
      while (!mergedPayload || mergedPayload.candles.length < TRAINING_REQUIRED_CANDLES) {
        const previousCount = mergedPayload?.candles.length ?? 0;
        const response = await fetch(nextRequest.url, { signal: controller.signal });
        const payload = await response.json() as { message?: string };
        if (!response.ok) {
          throw new Error(payload.message || "Binance Futures 历史行情暂时不可用");
        }
        pages.push(payload);
        mergedPayload = mergeTrainingHistoryPages(pages);
        if (mergedPayload.candles.length <= previousCount) {
          throw new RangeError("Binance 返回的训练历史没有继续向前推进");
        }
        if (mergedPayload.candles.length < TRAINING_REQUIRED_CANDLES) {
          const earliestTime = Number(mergedPayload.candles[0]?.time);
          nextRequest = createTrainingHistoryRequest({
            interval: TRAINING_MAIN_INTERVAL,
            endTime: earliestTime * 1000 - 1,
            limit: Math.min(
              TRAINING_REQUEST_PAGE_SIZE,
              TRAINING_REQUIRED_CANDLES - mergedPayload.candles.length,
            ),
          });
        }
      }
      const prepared = prepareTrainingCandles(mergedPayload, {
        contextCandles: TRAINING_CONTEXT_CANDLES,
        trainingCandles: TRAINING_FUTURE_CANDLES,
      });
      if (controller.signal.aborted) return;

      const startedAt = new Date().toISOString();
      const nextSession = createTrainingSession({
        id: `btc-training-${Date.now()}-${Math.floor(randomUnit() * 1_000_000)}`,
        symbol: "BTCUSDT",
        startingCapital: 10_000,
        leverage: 1,
        startedAt,
      });
      setCandles(prepared.candles);
      setCursor(prepared.initialCursor);
      setSession(nextSession);
      setMarkers([]);
      setContext({
        sessionId: nextSession.id,
        interval: TRAINING_MAIN_INTERVAL,
        source: prepared.source,
        initialCursor: prepared.initialCursor,
        windowStartTime: prepared.candles[0].time * 1000,
        windowEndTime: prepared.candles.at(-1)!.closeTime,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setNotice(error instanceof Error ? error.message : "无法开始训练，请稍后重试");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const addMarker = useCallback((
    direction: "buy" | "sell",
    label: string,
    action?: TrainingActionRecord,
  ) => {
    if (!currentCandle) return null;
    const marker: TrainingMarker = {
      id: action?.actionId ?? `training-action-${Date.now()}`,
      ...(action?.actionId ? { actionId: action.actionId } : {}),
      time: action?.marketLocation
        ? action.marketLocation.candleOpenTimeMs / 1000
        : currentCandle.time,
      direction,
      label,
      price: action?.price ?? currentCandle.close,
    };
    setMarkers((current) => [...current, marker]);
    return marker;
  }, [currentCandle]);

  const tradeByDirection = useCallback((direction: "buy" | "sell") => {
    if (!session || !snapshot || !currentCandle) return;
    const now = new Date().toISOString();
    const marketLocation = context
      ? createTrainingMarketLocation({
          candle: currentCandle,
          candleIndex: cursor,
          context,
          timing: "candle-close",
        })
      : undefined;
    const position = session.position;
    let nextSession: TrainingSession;
    let label: string;

    try {
      if (!position) {
        nextSession = applyTrainingAction(session, {
          type: "open",
          side: direction === "buy" ? "long" : "short",
          price: currentCandle.close,
          margin: snapshot.availableCapital * ratio,
          time: now,
          marketLocation,
        });
        label = direction === "buy" ? "BUY 开多" : "SELL 开空";
      } else {
        const addsPosition =
          (position.side === "long" && direction === "buy") ||
          (position.side === "short" && direction === "sell");
        if (addsPosition) {
          nextSession = applyTrainingAction(session, {
            type: "add",
            price: currentCandle.close,
            capitalRatio: ratio,
            time: now,
            marketLocation,
          });
          label = direction === "buy" ? "BUY 加多" : "SELL 加空";
        } else if (ratio === 1) {
          nextSession = applyTrainingAction(session, {
            type: "close",
            price: currentCandle.close,
            time: now,
            marketLocation,
          });
          label = direction === "buy" ? "BUY 平空" : "SELL 平多";
        } else {
          nextSession = applyTrainingAction(session, {
            type: "reduce",
            price: currentCandle.close,
            positionRatio: ratio,
            time: now,
            marketLocation,
          });
          label = direction === "buy" ? "BUY 减空" : "SELL 减多";
        }
      }
      setSession(nextSession);
      addMarker(
        direction,
        `${label} ${Math.round(ratio * 100)}%`,
        nextSession.actions.at(-1),
      );
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "本次仓位操作失败");
    }
  }, [addMarker, context, currentCandle, cursor, ratio, session, snapshot]);

  const updateRiskPrice = useCallback((
    kind: TrainingRiskKind,
    price: number,
  ) => {
    if (!session?.position || !currentCandle || !context) return;
    const time = new Date().toISOString();
    const marketLocation = createTrainingMarketLocation({
      candle: currentCandle,
      candleIndex: cursor,
      context,
      timing: "candle-close",
    });
    try {
      const next = kind === "takeProfit"
        ? setTrainingRiskLevels(session, {
            takeProfit: price,
            takeProfitRatio: ratio,
            currentPrice: currentCandle.close,
            time,
            source: "drag",
            marketLocation,
          })
        : setTrainingRiskLevels(session, {
            stopLoss: price,
            stopLossRatio: ratio,
            currentPrice: currentCandle.close,
            time,
            source: "drag",
            marketLocation,
          });
      setSession(next);
      setNotice(
        `${kind === "takeProfit" ? "止盈 TP" : "止损 SL"} 已更新为 ${formatPrice(price)}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新止盈止损");
    }
  }, [context, currentCandle, cursor, ratio, session]);

  const placeLimitOrderAtPrice = useCallback((
    side: "buy" | "sell",
    price: number,
    orderRatio: OrderRatio,
  ) => {
    if (!session || !currentCandle || !context) return;
    try {
      const next = placeTrainingLimitOrder(session, {
        side,
        price,
        currentPrice: currentCandle.close,
        ratio: orderRatio,
        time: new Date().toISOString(),
        marketLocation: createTrainingMarketLocation({
          candle: currentCandle,
          candleIndex: cursor,
          context,
          timing: "candle-close",
        }),
      });
      setSession(next);
      setNotice(
        `${side === "buy" ? "BUY" : "SELL"} LIMIT ${formatPrice(price)} · ${Math.round(orderRatio * 100)}% 已挂出`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建限价单");
    }
  }, [context, currentCandle, cursor, session]);

  const cancelLimitOrder = useCallback((limitOrderId: string) => {
    if (!session || !currentCandle || !context) return;
    try {
      const next = cancelTrainingLimitOrder(session, {
        limitOrderId,
        time: new Date().toISOString(),
        marketLocation: createTrainingMarketLocation({
          candle: currentCandle,
          candleIndex: cursor,
          context,
          timing: "candle-close",
        }),
      });
      setSession(next);
      setNotice("限价单已撤销");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法撤销限价单");
    }
  }, [context, currentCandle, cursor, session]);

  const processRevealedCandle = useCallback((
    activeSession: TrainingSession,
    candle: MarketCandle,
    candleIndex: number,
  ) => {
    const result = processTrainingCandle(activeSession, candle, {
      time: new Date().toISOString(),
      ...(context
        ? {
            marketLocation: createTrainingMarketLocation({
              candle,
              candleIndex,
              context,
              timing: "intrabar-unknown",
            }),
          }
        : {}),
    });
    const trigger = result.trigger;
    if (trigger) {
      const direction = trigger.side === "long" ? "sell" : "buy";
      const triggerLabel = trigger.kind === "takeProfit" ? "TP" : "SL";
      const partial = trigger.positionRatio !== undefined &&
        trigger.positionRatio < 1;
      const positionLabel = trigger.side === "long"
        ? partial ? "部分平多" : "平多"
        : partial ? "部分平空" : "平空";
      const action = result.session.actions.at(-1);
      setMarkers((current) => [
        ...current,
        {
          id: action?.actionId ??
            `training-risk-${activeSession.id}-${trigger.time}-${trigger.kind}`,
          ...(action?.actionId ? { actionId: action.actionId } : {}),
          time: action?.marketLocation
            ? action.marketLocation.candleOpenTimeMs / 1000
            : trigger.candleTime,
          direction,
          label: `${direction.toUpperCase()} ${triggerLabel} 自动${positionLabel}`,
          price: trigger.price,
        },
      ]);
    }
    if (result.limitTriggers.length > 0) {
      setMarkers((current) => [
        ...current,
        ...result.limitTriggers.map((limitTrigger) => {
          const action = result.session.actions.find(
            (item) => item.actionId === limitTrigger.actionId,
          );
          return {
            id: action?.actionId ??
              `training-limit-${activeSession.id}-${limitTrigger.limitOrderId}`,
            ...(action?.actionId ? { actionId: action.actionId } : {}),
            time: action?.marketLocation
              ? action.marketLocation.candleOpenTimeMs / 1000
              : limitTrigger.candleTime,
            direction: limitTrigger.side,
            label: `${limitTrigger.side.toUpperCase()} LIMIT ${Math.round(limitTrigger.ratio * 100)}%`,
            price: limitTrigger.price,
          };
        }),
      ]);
    }
    return result;
  }, [context]);

  const finishTraining = useCallback(() => {
    if (!session || !currentCandle || !context) return false;
    if (session.position) {
      setNotice("请先全部平仓，再结束并保存训练");
      return false;
    }
    if (session.limitOrders.length > 0) {
      setNotice("请先撤销全部限价单，再结束并保存训练");
      return false;
    }
    try {
      const endedAt = new Date().toISOString();
      const result = finishTrainingSession(session, {
        endedAt,
      });
      const summary = buildTrainingSessionSummary({
        result,
        candles: candles.slice(0, cursor + 1),
        mainTimeframe,
      });
      const record: TrainingResultRecord = {
        ...result,
        interval: context.interval,
        source: context.source,
        windowStartTime: context.windowStartTime,
        windowEndTime: currentCandle.closeTime,
        barsViewed: Math.max(1, cursor - context.initialCursor + 1),
        markers,
        recordedAt: endedAt,
        mainTimeframe,
        summary,
      };
      onResultsChange([record, ...trainingResults.filter((item) => item.id !== record.id)]);
      setLastResult(record);
      setSession(null);
      setNotice(`本局训练已保存：${formatMoney(record.netPnl, true)}`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法结束本局训练");
      return false;
    }
  }, [
    candles,
    context,
    currentCandle,
    cursor,
    mainTimeframe,
    markers,
    onResultsChange,
    session,
    trainingResults,
  ]);

  const startNewRound = useCallback(async () => {
    if (session && !finishTraining()) return false;
    await startTraining();
    return true;
  }, [finishTraining, session, startTraining]);

  const nextCandle = useCallback(async () => {
    if (!session || !context || candles.length === 0 || loadingMore) return;
    if (cursor < candles.length - 1) {
      const nextCursor = cursor + 1;
      try {
        const result = processRevealedCandle(session, candles[nextCursor], nextCursor);
        setSession(result.session);
        setCursor(nextCursor);
        setNotice(result.trigger
          ? `${result.trigger.kind === "takeProfit" ? "TP 止盈" : "SL 止损"} 已触发，按 ${formatPrice(result.trigger.price)} ${result.trigger.positionRatio && result.trigger.positionRatio < 1 ? `部分平仓 ${Math.round(result.trigger.positionRatio * 100)}%` : "自动全平"}`
          : result.limitTriggers.length > 0
            ? `已触发 ${result.limitTriggers.length} 笔限价单`
            : "");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "无法推进下一根 K 线");
      }
      return;
    }
    const lastCandle = candles.at(-1)!;
    const request = createTrainingContinuationRequest({
      interval: TRAINING_MAIN_INTERVAL,
      startTime: lastCandle.closeTime + 1,
      limit: 240,
    });
    continuationControllerRef.current?.abort();
    const controller = new AbortController();
    continuationControllerRef.current = controller;
    setLoadingMore(true);
    setNotice(
      session.position
        ? "当前仍有持仓，正在加载后续真实行情…"
        : session.limitOrders.length > 0
          ? "当前仍有限价挂单，正在加载后续真实行情…"
          : "本段行情已结束，正在加载后续真实行情…",
    );

    try {
      const response = await fetch(request.url, { signal: controller.signal });
      const payload = await response.json() as { message?: string };
      if (!response.ok) {
        throw new Error(payload.message || "Binance Futures 后续行情暂时不可用");
      }
      const prepared = prepareTrainingContinuationCandles(payload, {
        afterCloseTime: lastCandle.closeTime,
      });
      if (controller.signal.aborted) return;

      const nextCursor = candles.length;
      const result = processRevealedCandle(session, prepared.candles[0], nextCursor);
      setSession(result.session);
      setCandles((current) => [...current, ...prepared.candles]);
      setCursor(nextCursor);
      setContext((current) => current
        ? {
            ...current,
            windowEndTime: prepared.candles.at(-1)!.closeTime,
          }
        : current);
      setNotice(result.trigger
        ? `${result.trigger.kind === "takeProfit" ? "TP 止盈" : "SL 止损"} 已触发，按 ${formatPrice(result.trigger.price)} 自动全平`
        : result.limitTriggers.length > 0
          ? `已触发 ${result.limitTriggers.length} 笔限价单`
          : session.position
            ? "当前仍有持仓，已继续展示后续真实行情"
            : session.limitOrders.length > 0
              ? "当前仍有限价挂单，已继续展示后续真实行情"
              : "已继续展示后续真实行情");
    } catch (error) {
      if (controller.signal.aborted) return;
      setNotice(error instanceof Error ? error.message : "无法加载后续真实行情");
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [
    candles,
    context,
    cursor,
    loadingMore,
    processRevealedCandle,
    session,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowRight" ||
        view !== "trade" ||
        !session ||
        loadingMore ||
        isTrainingKeyboardInput(event.target) ||
        workspaceRef.current?.closest("[hidden]")
      ) {
        return;
      }
      event.preventDefault();
      void nextCandle();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loadingMore, nextCandle, session, view]);

  const position = session?.position ?? null;
  const riskExpectation: TrainingRiskExpectation = useMemo(
    () => calculateTrainingRiskExpectation({
      startingCapital: session?.startingCapital ?? 10_000,
      position,
      risk: session?.risk ?? null,
    }),
    [position, session?.risk, session?.startingCapital],
  );
  const takeProfitLabel = riskExpectation.takeProfit
    ? `TP ${riskExpectation.takeProfit.pnl >= 0 ? "+" : ""}${riskExpectation.takeProfit.pnl.toFixed(2)} · ${Math.round(riskExpectation.takeProfit.positionRatio * 100)}%`
    : "TP";
  const stopLossLabel = riskExpectation.stopLoss
    ? `SL ${riskExpectation.stopLoss.pnl >= 0 ? "+" : ""}${riskExpectation.stopLoss.pnl.toFixed(2)} · ${Math.round(riskExpectation.stopLoss.positionRatio * 100)}%`
    : "SL";
  const buyLabel = !position
    ? "买入开多"
    : position.side === "long"
      ? "买入加多"
      : ratio === 1 ? "买入平空" : "买入减空";
  const sellLabel = !position
    ? "卖出开空"
    : position.side === "short"
      ? "卖出加空"
      : ratio === 1 ? "卖出平多" : "卖出减多";
  const currentTotalPnl = snapshot
    ? snapshot.realizedPnl + snapshot.unrealizedPnl
    : lastResult?.netPnl ?? null;
  const availableCapitalRatio = snapshot && snapshot.equity > 0
    ? Math.min(1, Math.max(0, snapshot.availableCapital / snapshot.equity))
    : 0;
  const availableCapitalPercent = Math.round(availableCapitalRatio * 100);
  const displayedAuditRecord = session ?? lastResult;
  const displayedActionCount = displayedAuditRecord && Array.isArray(displayedAuditRecord.actions)
    ? displayedAuditRecord.actions.length
    : 0;
  const displayedRiskChangeCount =
    displayedAuditRecord && Array.isArray(displayedAuditRecord.riskChanges)
      ? displayedAuditRecord.riskChanges.length
      : 0;
  const displayedLimitChangeCount =
    displayedAuditRecord &&
    Array.isArray(displayedAuditRecord.limitOrderChanges)
      ? displayedAuditRecord.limitOrderChanges.length
      : 0;
  const displayedOperationCount =
    displayedActionCount +
    displayedRiskChangeCount +
    displayedLimitChangeCount +
    (displayedActionCount === 0 &&
    displayedRiskChangeCount === 0 &&
    displayedLimitChangeCount === 0
      ? markers.length
      : 0);

  return (
    <section
      ref={workspaceRef}
      id="training-module"
      className={styles.trainingWorkspace}
      aria-label="BTC 行情训练模式"
    >
      <header className={styles.trainingHeader}>
        <div>
          <h1>行情训练</h1>
        </div>
        <nav className={styles.trainingTabs} aria-label="训练功能切换">
          <button
            type="button"
            className={view === "trade" ? styles.active : ""}
            onClick={() => setView("trade")}
            aria-pressed={view === "trade"}
          >
            <Play size={14} />模拟交易
          </button>
          <button
            type="button"
            className={view === "performance" ? styles.active : ""}
            onClick={() => setView("performance")}
            aria-pressed={view === "performance"}
          >
            <BarChart3 size={14} />训练表现
          </button>
        </nav>
      </header>

      {view === "performance" ? (
        <TrainingPerformanceBoard
          results={trainingResults}
          onResultsChange={onResultsChange}
        />
      ) : (
        <div className={styles.trainingDesk}>
          <div className={styles.trainingToolbar}>
            <label>
              <span>主图周期</span>
              <select
                aria-label="训练主图时间框架"
                value={mainTimeframe}
                onChange={(event) => setMainTimeframe(
                  event.currentTarget.value as TrainingMainTimeframe,
                )}
              >
                {(Object.keys(TRAINING_MAIN_TIMEFRAME_LABELS) as TrainingMainTimeframe[])
                  .map((timeframe) => (
                    <option key={timeframe} value={timeframe}>
                      {TRAINING_MAIN_TIMEFRAME_LABELS[timeframe]}
                    </option>
                  ))}
              </select>
            </label>
            <div className={styles.trainingSource}>
              <i />
              <span>{context?.source ?? "真实 Binance Futures 历史行情"} · 15m 推进</span>
            </div>
            <div className={styles.trainingQuickTrade} aria-label="训练快捷交易">
              <div className={styles.ratioControl} role="group" aria-label="本次操作比例">
                <span>本次比例</span>
                {([0.1, 0.25, 0.5, 1] as OrderRatio[]).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={ratio === value ? styles.active : ""}
                    onClick={() => setRatio(value)}
                    aria-pressed={ratio === value}
                  >
                    {Math.round(value * 100)}%
                  </button>
                ))}
              </div>
              <div className={styles.tradeButtons}>
                <button
                  type="button"
                  className={styles.buyButton}
                  onClick={() => tradeByDirection("buy")}
                  disabled={!session || !currentCandle}
                  title={buyLabel}
                >
                  <ArrowUp size={15} />
                  <span>买入</span>
                  <small>{buyLabel}</small>
                </button>
                <button
                  type="button"
                  className={styles.sellButton}
                  onClick={() => tradeByDirection("sell")}
                  disabled={!session || !currentCandle}
                  title={sellLabel}
                >
                  <ArrowDown size={15} />
                  <span>卖出</span>
                  <small>{sellLabel}</small>
                </button>
              </div>
              <button
                type="button"
                className={styles.quickNextButton}
                onClick={() => void nextCandle()}
                disabled={!session || loadingMore}
                title="推进下一根 K 线（也可按键盘右方向键）"
              >
                <SkipForward size={14} />
                {loadingMore
                  ? "加载后续…"
                  : atLoadedEnd ? "查看后续 K 线" : "下一根 K 线"}
              </button>
              <div className={styles.quickPnl}>
                <span>当前盈亏</span>
                <strong className={(currentTotalPnl ?? 0) >= 0 ? styles.profitText : styles.lossText}>
                  {currentTotalPnl === null ? "—" : formatMoney(currentTotalPnl, true)}
                </strong>
              </div>
              <div className={styles.availableCapitalGauge}>
                <div
                  className={styles.capitalRing}
                  role="img"
                  aria-label={`可用资金占账户权益 ${availableCapitalPercent}%`}
                  style={{
                    background: `conic-gradient(var(--amber) ${availableCapitalRatio * 360}deg, var(--border-soft) 0deg)`,
                  }}
                >
                  <div><strong>{availableCapitalPercent}%</strong></div>
                </div>
                <div>
                  <span>可用资金</span>
                  <strong>{snapshot ? formatMoney(snapshot.availableCapital) : "—"}</strong>
                </div>
              </div>
            </div>
            <button
              type="button"
              className={styles.startButton}
              onClick={() => void startNewRound()}
              disabled={!canStartNewRound || loading}
            >
              {loading ? "随机抽取中…" : candles.length > 0 ? "开始新一局" : "开始训练"}
            </button>
          </div>

          {notice && <div className={styles.trainingNotice} role="status">{notice}</div>}

          <section className={styles.chartCard} aria-label="BTC 随机训练行情">
            <div className={styles.ohlcStrip}>
              <span>BTCUSDT 永续 · {mainTimeframe}</span>
              <span>开 <b>{mainCurrentCandle ? formatPrice(mainCurrentCandle.open) : "—"}</b></span>
              <span>高 <b className={styles.profitText}>{mainCurrentCandle ? formatPrice(mainCurrentCandle.high) : "—"}</b></span>
              <span>低 <b className={styles.lossText}>{mainCurrentCandle ? formatPrice(mainCurrentCandle.low) : "—"}</b></span>
              <span>收 <b>{mainCurrentCandle ? formatPrice(mainCurrentCandle.close) : "—"}</b></span>
              <span className={styles.hiddenFuture}>未来行情已隐藏</span>
            </div>
            {candles.length > 0 ? (
              <div className={styles.trainingChartLayout}>
                <TrainingChart
                  sessionId={context?.sessionId ?? "training-uninitialized"}
                  timeframe={mainTimeframe}
                  candles={mainChartCandles}
                  markers={markers}
                  averagePrice={position?.averagePrice ?? null}
                  positionSide={position?.side ?? null}
                  takeProfit={session?.risk?.takeProfit ?? null}
                  stopLoss={session?.risk?.stopLoss ?? null}
                  takeProfitLabel={takeProfitLabel}
                  stopLossLabel={stopLossLabel}
                  limitOrders={session?.limitOrders ?? []}
                  drawings={drawings}
                  canPlaceLimitOrder={Boolean(session && currentCandle)}
                  onPlaceLimitOrder={placeLimitOrderAtPrice}
                  onCancelLimitOrder={cancelLimitOrder}
                  onDrawingsChange={setDrawings}
                  onRiskPriceChange={updateRiskPrice}
                />
                <aside
                  className={styles.trainingTimeframeRail}
                  aria-label="高时间框架行情"
                >
                  <div role="img" aria-label="4H 训练周期图">
                    <TrainingMiniChart
                      label="4H"
                      candles={timeframes["4H"]}
                      sessionId={context?.sessionId ?? "training-uninitialized"}
                      drawings={drawings}
                    />
                  </div>
                  <div role="img" aria-label="1D 训练周期图">
                    <TrainingMiniChart
                      label="1D"
                      candles={timeframes["1D"]}
                      sessionId={context?.sessionId ?? "training-uninitialized"}
                      drawings={drawings}
                    />
                  </div>
                </aside>
              </div>
            ) : (
              <div className={styles.trainingEmpty}>
                <BarChart3 size={30} />
                <strong>准备一段随机 BTC 历史行情</strong>
                <span>点击开始训练后，只会显示起始上下文，后续 K 线需要逐根推进。</span>
                <button type="button" onClick={() => void startTraining()} disabled={loading}>
                  <Play size={15} />{loading ? "正在获取…" : "开始训练"}
                </button>
              </div>
            )}
            {loading && <div className={styles.loadingCover}><span />正在随机获取真实历史行情</div>}
          </section>

          {lastResult && !session && <TrainingSummaryCard record={lastResult} />}

          {displayedAuditRecord && displayedOperationCount > 0 && (
            <section className={styles.actionLog} aria-label="本局操作记录">
              <div className={styles.panelHeading}>
                <div><RotateCcw size={15} /><strong>本局操作</strong></div>
                <span>{displayedOperationCount} 次完整记录</span>
              </div>
              <TrainingOperationTable
                record={displayedAuditRecord}
                markers={markers}
              />
            </section>
          )}
        </div>
      )}
    </section>
  );
}
