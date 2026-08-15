import {
  buildPartialCandle,
  buildReplayPositionState,
  buildReplayProgressNodes,
  buildReplayTradeSnapshot,
  getCandlePhaseAtTime,
  getReplayOpenInterestPoints,
  getReplayTimeMs,
  getReplayVolume,
  type ReplayPositionState,
  type ReplayProgressAction,
  type ReplayProgressNode,
  type ReplayTradeSnapshot,
} from "@/lib/replay.mjs";
import {
  buildReplayEmaSeries,
  buildReplayOrderFlowSeries,
  buildVolumeCandleColorPoint,
} from "@/lib/indicators.mjs";
import {
  getReplayPriceLines,
  type ReplayRiskLevel,
} from "@/lib/risk.mjs";
import {
  type NormalizedTrade,
  type TradePnlResult,
} from "@/lib/trade.mjs";
import {
  buildFixedReplayContext,
  createReplayTimeframeAggregator,
  type ReplayTimeframeAggregator,
} from "@/lib/video-timeframes.mjs";

export const REPLAY_VIDEO_WIDTH = 1920;
export const REPLAY_VIDEO_HEIGHT = 1080;

export type ReplayVideoIndicatorVisibility = {
  ema21: boolean;
  ema200: boolean;
  volumeColoring: boolean;
  volume: boolean;
  openInterest: boolean;
  delta: boolean;
  cvd: boolean;
};

export type ReplayVideoTimeframe = "5m" | "15m" | "1H" | "4H" | "1D";
export type ReplayVideoSecondaryTimeframes = readonly [
  ReplayVideoTimeframe,
  ReplayVideoTimeframe,
  ReplayVideoTimeframe,
];
export type ReplayVideoVolumeColoringConfig = {
  rvolPeriod: number;
  lookback: number;
};

export type ReplayVideoCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume?: number;
  closeTime?: number;
};

export type ReplayVideoOpenInterestPoint = {
  time: number;
  openInterest: number;
  openInterestValue?: number;
};

type NormalizedReplayVideoCandle = ReplayVideoCandle & {
  closeTime: number;
};

export interface ReplayVideoTrade extends NormalizedTrade {
  id?: string;
  title?: string;
  strategy?: string;
  riskLevels?: ReplayRiskLevel[];
}

export type ReplayVideoRange = {
  startIndex: number;
  endIndex: number;
  preEntryCandles?: number;
  postExitCandles?: number;
};

export type ReplayVideoFrameInput = {
  trade: ReplayVideoTrade;
  /** 导出期间应保持数组及其 K 线对象只读，以便复用逐帧标准化缓存。 */
  candles: readonly ReplayVideoCandle[];
  openInterest: ReplayVideoOpenInterestPoint[];
  candleIndex: number;
  phase: number;
  entryIndex: number;
  range: ReplayVideoRange;
  timeframe: ReplayVideoTimeframe;
  secondaryTimeframes: ReplayVideoSecondaryTimeframes;
  speed: number;
  source: string;
  indicatorVisibility: ReplayVideoIndicatorVisibility;
  volumeColoringConfig: ReplayVideoVolumeColoringConfig;
};

export type ReplayVideoFrameMetadata = {
  width: typeof REPLAY_VIDEO_WIDTH;
  height: typeof REPLAY_VIDEO_HEIGHT;
  replayTimeMs: number;
  progress: number;
  currentCandle: NormalizedReplayVideoCandle;
  hasEntered: boolean;
  visibleExitCount: number;
  pnl: TradePnlResult | null;
};

type Pane = {
  key: "volume" | "openInterest" | "delta" | "cvd";
  label: string;
  top: number;
  height: number;
};

const FONT_FAMILY = '"Microsoft YaHei", "Segoe UI", Arial, sans-serif';
const POSITION_BAR_Y = 950;
const POSITION_BAR_HEIGHT = 10;
const POSITION_BAR_LABEL_X = 32;
const POSITION_BAR_TRACK_X = 160;
const POSITION_BAR_TRACK_WIDTH = 1728;
const LONG_POSITION_COLORS = [
  "#30c487",
  "#55d29c",
  "#78dfb3",
  "#28ad79",
];
const SHORT_POSITION_COLORS = [
  "#ef6572",
  "#f1848e",
  "#f4a0a8",
  "#d9505f",
];
const NORMALIZED_CANDLE_CACHE = new WeakMap<
  readonly ReplayVideoCandle[],
  NormalizedReplayVideoCandle[]
>();
const TIMEFRAME_AGGREGATOR_CACHE = new WeakMap<
  readonly NormalizedReplayVideoCandle[],
  ReplayTimeframeAggregator
>();
const COLORS = {
  app: "#090f16",
  header: "#0d151f",
  panelMuted: "#182431",
  border: "#263546",
  white: "#ffffff",
  ink: "#111111",
  muted: "#667085",
  grid: "#e7ebf0",
  green: "#30c487",
  red: "#ef6572",
  amber: "#d49a25",
  blue: "#2962ff",
  purple: "#8b5cf6",
  orange: "#e58b18",
  teal: "#0f9f8f",
  volumeBullish: "#00df3b",
  volumeBearish: "#ff304f",
  volumeLow: "#ffd400",
};

/**
 * 将当前回放状态绘制为固定 1920×1080 视频帧。
 * 此函数只负责绘图，不推进游标，也不触碰 MediaRecorder 或文件系统。
 */
export function renderReplayVideoFrame(
  canvas: HTMLCanvasElement,
  input: ReplayVideoFrameInput,
): ReplayVideoFrameMetadata {
  const state = normalizeFrameInput(input);
  if (canvas.width !== REPLAY_VIDEO_WIDTH) canvas.width = REPLAY_VIDEO_WIDTH;
  if (canvas.height !== REPLAY_VIDEO_HEIGHT) canvas.height = REPLAY_VIDEO_HEIGHT;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法创建 2D Canvas 上下文");

  context.clearRect(0, 0, REPLAY_VIDEO_WIDTH, REPLAY_VIDEO_HEIGHT);
  context.fillStyle = COLORS.app;
  context.fillRect(0, 0, REPLAY_VIDEO_WIDTH, REPLAY_VIDEO_HEIGHT);

  drawHeader(context, state);
  drawChart(context, state);
  drawMultiTimeframePanels(context, state);
  drawPositionBar(context, state);
  drawProgress(context, state);

  return {
    width: REPLAY_VIDEO_WIDTH,
    height: REPLAY_VIDEO_HEIGHT,
    replayTimeMs: state.replayTimeMs,
    progress: state.progress,
    currentCandle: state.currentCandle,
    hasEntered: state.hasEntered,
    visibleExitCount: state.visibleExits.length,
    pnl: state.pnl,
  };
}

type NormalizedFrameState = {
  trade: ReplayVideoTrade;
  candles: NormalizedReplayVideoCandle[];
  openInterest: ReplayVideoOpenInterestPoint[];
  safeIndex: number;
  safeEntryIndex: number;
  rangeStart: number;
  rangeEnd: number;
  phase: number;
  speed: number;
  source: string;
  mainTimeframe: ReplayVideoTimeframe;
  secondaryTimeframes: ReplayVideoSecondaryTimeframes;
  indicatorVisibility: ReplayVideoIndicatorVisibility;
  volumeColoringConfig: ReplayVideoVolumeColoringConfig;
  timeframes: ReturnType<ReplayTimeframeAggregator["build"]>;
  currentCandle: NormalizedReplayVideoCandle;
  replayTimeMs: number;
  entryTimeMs: number;
  hasEntered: boolean;
  visibleExits: ReplayVideoTrade["exits"];
  positionState: ReplayPositionState;
  tradeSnapshot: ReplayTradeSnapshot;
  pnl: TradePnlResult | null;
  progress: number;
};

function normalizeFrameInput(input: ReplayVideoFrameInput): NormalizedFrameState {
  if (!input || typeof input !== "object") {
    throw new TypeError("视频帧输入必须是对象");
  }
  if (!Array.isArray(input.candles) || input.candles.length === 0) {
    throw new TypeError("导出视频至少需要一根 K 线");
  }
  const candles = getNormalizedCandles(input.candles);
  const lastIndex = candles.length - 1;
  const rangeStart = clampInteger(input.range?.startIndex, 0, lastIndex);
  const rangeEnd = clampInteger(input.range?.endIndex, rangeStart, lastIndex);
  const safeIndex = clampInteger(input.candleIndex, rangeStart, rangeEnd);
  const safeEntryIndex = clampInteger(input.entryIndex, 0, lastIndex);
  const phase = clamp(Number(input.phase), 0, 1);
  const partialCandle = buildPartialCandle(candles[safeIndex], phase);
  const currentCandle = {
    ...partialCandle,
    volume: getReplayVolume(candles[safeIndex].volume, phase),
    ...(candles[safeIndex].takerBuyVolume === undefined
      ? {}
      : {
          takerBuyVolume: getReplayVolume(
            candles[safeIndex].takerBuyVolume,
            phase,
          ),
        }),
  };
  const replayTimeMs = getReplayTimeMs(
    candles[safeIndex],
    phase,
    candles[safeIndex + 1],
  );
  const parsedEntryTime = Date.parse(input.trade.entryTime ?? "");
  const entryTimeMs = Number.isFinite(parsedEntryTime)
    ? parsedEntryTime
    : candles[safeEntryIndex].time * 1000;
  const tradeSnapshot = buildReplayTradeSnapshot(
    input.trade,
    replayTimeMs,
    currentCandle.close,
  );
  const hasEntered = tradeSnapshot.hasEntered;
  const visibleExits = tradeSnapshot.visibleExits;
  const positionState = buildReplayPositionState(input.trade, replayTimeMs);
  const mainTimeframe = normalizeVideoTimeframe(input.timeframe, "视频主图周期");
  const secondaryTimeframes = normalizeSecondaryTimeframes(
    input.secondaryTimeframes,
  );
  const volumeColoringConfig = normalizeVideoVolumeColoringConfig(
    input.volumeColoringConfig,
  );
  const timeframes = getTimeframeAggregator(candles).build({
    cursor: safeIndex,
    replayTimeMs,
    currentCandle,
  });

  const progressDenominator = Math.max(1, rangeEnd - rangeStart + 1);
  const progress = clamp(
    (safeIndex - rangeStart + phase) / progressDenominator,
    0,
    1,
  );

  return {
    trade: input.trade,
    candles,
    openInterest: Array.isArray(input.openInterest)
      ? input.openInterest.filter(
          (point) =>
            Number.isFinite(point?.time) &&
            Number.isFinite(point?.openInterest),
        )
      : [],
    safeIndex,
    safeEntryIndex,
    rangeStart,
    rangeEnd,
    phase,
    speed: Number.isFinite(input.speed) && input.speed > 0 ? input.speed : 1,
    source: String(input.source || "未知来源"),
    mainTimeframe,
    secondaryTimeframes,
    indicatorVisibility: input.indicatorVisibility,
    volumeColoringConfig,
    timeframes,
    currentCandle,
    replayTimeMs,
    entryTimeMs,
    hasEntered,
    visibleExits,
    positionState,
    tradeSnapshot,
    pnl: tradeSnapshot.pnl,
    progress,
  };
}

function drawHeader(context: CanvasRenderingContext2D, state: NormalizedFrameState) {
  context.fillStyle = COLORS.header;
  context.fillRect(0, 0, REPLAY_VIDEO_WIDTH, 86);
  context.strokeStyle = COLORS.border;
  context.beginPath();
  context.moveTo(0, 85.5);
  context.lineTo(REPLAY_VIDEO_WIDTH, 85.5);
  context.stroke();

  context.fillStyle = COLORS.amber;
  roundedRect(context, 32, 20, 42, 42, 10);
  context.fill();
  context.fillStyle = COLORS.app;
  context.font = `700 24px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("CR", 53, 42);

  context.textAlign = "left";
  context.fillStyle = COLORS.white;
  context.font = `700 28px ${FONT_FAMILY}`;
  context.fillText("CryptoReview · 交易复盘", 92, 36);
  context.fillStyle = "#9aabba";
  context.font = `400 16px ${FONT_FAMILY}`;
  context.fillText(
    `${state.trade.symbol} 永续合约  ·  ${sideLabel(state.trade.side)}  ·  ${state.mainTimeframe}  ·  ${formatSpeed(state.speed)}`,
    92,
    61,
  );

  drawHeaderChip(context, 1265, "行情来源", state.source);
  drawHeaderChip(context, 1530, "回放时间", formatDateTime(state.replayTimeMs));

  context.fillStyle = COLORS.amber;
  roundedRect(context, 1788, 23, 100, 40, 12);
  context.fill();
  context.fillStyle = COLORS.app;
  context.font = `700 17px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.fillText("1080P", 1838, 44);
}

function drawHeaderChip(
  context: CanvasRenderingContext2D,
  x: number,
  label: string,
  value: string,
) {
  context.fillStyle = COLORS.panelMuted;
  roundedRect(context, x, 17, 238, 52, 12);
  context.fill();
  context.textAlign = "left";
  context.fillStyle = "#7f91a3";
  context.font = `400 12px ${FONT_FAMILY}`;
  context.fillText(label, x + 14, 34);
  context.fillStyle = "#e5ecf3";
  context.font = `600 14px ${FONT_FAMILY}`;
  drawFittedText(context, value, x + 14, 55, 210);
}

type ReplayVideoChartSeries = {
  candles: readonly ReplayVideoCandle[];
  cursor: number;
  currentCandle: ReplayVideoCandle;
  phase: number;
};

function resolveVideoChartSeries(
  state: NormalizedFrameState,
  timeframe: ReplayVideoTimeframe,
): ReplayVideoChartSeries {
  if (timeframe === "5m") {
    return {
      candles: state.candles,
      cursor: state.safeIndex,
      currentCandle: state.currentCandle,
      phase: state.phase,
    };
  }
  const candles = state.timeframes[timeframe];
  const currentCandle = candles.at(-1);
  if (!currentCandle) {
    throw new RangeError(`${timeframe} 视频行情为空`);
  }
  return {
    candles,
    cursor: candles.length - 1,
    currentCandle,
    phase: 1,
  };
}

function getReplayVideoCandleTone(
  candles: readonly ReplayVideoCandle[],
  index: number,
  currentIndex: number,
  currentCandle: ReplayVideoCandle,
  config: ReplayVideoVolumeColoringConfig,
) {
  if (index !== currentIndex) {
    return buildVolumeCandleColorPoint(candles, index, config).tone;
  }
  const historyLength = Math.max(config.rvolPeriod, config.lookback - 1);
  const startIndex = Math.max(0, index - historyLength);
  const window = [
    ...candles.slice(startIndex, index),
    currentCandle,
  ];
  return buildVolumeCandleColorPoint(window, window.length - 1, config).tone;
}

function replayVideoCandleFill(
  tone: ReturnType<typeof buildVolumeCandleColorPoint>["tone"],
  isUp: boolean,
) {
  if (tone === "bullish") return COLORS.volumeBullish;
  if (tone === "bearish") return COLORS.volumeBearish;
  if (tone === "low") return COLORS.volumeLow;
  return isUp ? COLORS.white : COLORS.ink;
}

function drawChart(context: CanvasRenderingContext2D, state: NormalizedFrameState) {
  const panel = { x: 32, y: 108, width: 1394, height: 834 };
  context.fillStyle = COLORS.white;
  roundedRect(context, panel.x, panel.y, panel.width, panel.height, 16);
  context.fill();

  const chartSeries = resolveVideoChartSeries(state, state.mainTimeframe);
  const current = chartSeries.currentCandle;
  context.fillStyle = COLORS.ink;
  context.font = `700 20px ${FONT_FAMILY}`;
  context.textAlign = "left";
  context.fillText(`${state.trade.symbol} · ${state.mainTimeframe}`, 54, 143);
  context.font = `500 14px ${FONT_FAMILY}`;
  context.fillStyle = COLORS.muted;
  context.fillText(`开 ${formatPrice(current.open)}`, 258, 143);
  context.fillText(`高 ${formatPrice(current.high)}`, 385, 143);
  context.fillText(`低 ${formatPrice(current.low)}`, 512, 143);
  context.fillStyle = current.close >= current.open ? COLORS.green : COLORS.red;
  context.fillText(`收 ${formatPrice(current.close)}`, 639, 143);

  const replayContext = buildFixedReplayContext(chartSeries.candles, {
    cursor: chartSeries.cursor,
    replayTimeMs: state.replayTimeMs,
    currentCandle: chartSeries.currentCandle,
    visibleCandles: 80,
  });
  const chartStartIndex = replayContext.startIndex;
  const visibleCandles = replayContext.candles;
  const plotLeft = 54;
  const plotRight = panel.x + panel.width - 86;
  const plotTop = 164;
  const plotBottom = panel.y + panel.height - 38;
  const plotWidth = plotRight - plotLeft;

  const orderFlow = buildReplayOrderFlowSeries(
    [...chartSeries.candles.slice(chartStartIndex)],
    chartSeries.cursor - chartStartIndex,
    chartSeries.phase,
  );
  drawIndicatorLegend(context, state, orderFlow.available, 790, 143);
  const paneKeys: Pane["key"][] = [];
  if (state.indicatorVisibility.volume) paneKeys.push("volume");
  if (state.indicatorVisibility.openInterest && state.openInterest.length > 0) {
    paneKeys.push("openInterest");
  }
  if (state.indicatorVisibility.delta && orderFlow.available) paneKeys.push("delta");
  if (state.indicatorVisibility.cvd && orderFlow.available) paneKeys.push("cvd");

  const availableHeight = plotBottom - plotTop - 28;
  const paneGap = 5;
  const secondaryHeight = paneKeys.length
    ? Math.min(88, Math.max(64, (availableHeight - 400) / paneKeys.length - paneGap))
    : 0;
  const priceHeight = availableHeight -
    paneKeys.length * (secondaryHeight + paneGap);
  const priceRect = {
    left: plotLeft,
    top: plotTop,
    width: plotWidth,
    height: priceHeight,
  };
  const panes = paneKeys.map((key, index): Pane => ({
    key,
    label: paneLabel(key),
    top: plotTop + priceHeight + paneGap + index * (secondaryHeight + paneGap),
    height: secondaryHeight,
  }));

  const replayPriceLines =
    state.hasEntered && state.tradeSnapshot.averageEntryPrice !== null
    ? getReplayPriceLines(
        {
          ...state.trade,
          entryPrice: state.tradeSnapshot.averageEntryPrice,
        },
        state.replayTimeMs,
      )
    : [];
  const ema21 = state.indicatorVisibility.ema21
    ? buildReplayEmaSeries(
        [...chartSeries.candles],
        chartSeries.cursor,
        chartSeries.currentCandle.close,
        21,
      ).filter((point) => point.time >= chartSeries.candles[chartStartIndex].time)
    : [];
  const ema200 = state.indicatorVisibility.ema200
    ? buildReplayEmaSeries(
        [...chartSeries.candles],
        chartSeries.cursor,
        chartSeries.currentCandle.close,
        200,
      ).filter((point) => point.time >= chartSeries.candles[chartStartIndex].time)
    : [];
  const priceValues = visibleCandles.flatMap((candle) => [candle.high, candle.low]);
  priceValues.push(...replayPriceLines.map((line) => line.price));
  priceValues.push(...ema21.map((point) => point.value));
  priceValues.push(...ema200.map((point) => point.value));
  const [priceMin, priceMax] = paddedRange(priceValues, 0.08);
  const priceY = (value: number) =>
    valueToY(value, priceMin, priceMax, priceRect.top, priceRect.height);

  drawPriceGrid(context, priceRect, priceMin, priceMax);
  const candleStep = priceRect.width / replayContext.slotCount;
  const xAt = (index: number) =>
    priceRect.left +
    (replayContext.paddingSlots + index + 0.5) * candleStep;
  const candleWidth = Math.max(2, Math.min(12, candleStep * 0.58));

  clipRect(context, priceRect.left, priceRect.top, priceRect.width, priceRect.height, () => {
    visibleCandles.forEach((candle, index) => {
      const x = xAt(index);
      const isUp = candle.close >= candle.open;
      const tone = state.indicatorVisibility.volumeColoring
        ? getReplayVideoCandleTone(
            chartSeries.candles,
            chartStartIndex + index,
            chartSeries.cursor,
            chartSeries.currentCandle,
            state.volumeColoringConfig,
          )
        : null;
      context.strokeStyle = COLORS.ink;
      context.lineWidth = Math.max(1.2, Math.min(2, candleWidth / 4));
      context.beginPath();
      context.moveTo(x, priceY(candle.high));
      context.lineTo(x, priceY(candle.low));
      context.stroke();

      const bodyTop = Math.min(priceY(candle.open), priceY(candle.close));
      const bodyHeight = Math.max(
        1.5,
        Math.abs(priceY(candle.open) - priceY(candle.close)),
      );
      context.fillStyle = replayVideoCandleFill(tone, isUp);
      context.strokeStyle = COLORS.ink;
      context.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      context.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    drawLineSeries(
      context,
      ema21,
      chartStartIndex,
      chartSeries.candles,
      chartSeries.cursor,
      xAt,
      priceY,
      COLORS.orange,
      2.2,
    );
    drawLineSeries(
      context,
      ema200,
      chartStartIndex,
      chartSeries.candles,
      chartSeries.cursor,
      xAt,
      priceY,
      COLORS.purple,
      2.2,
    );

    replayPriceLines.forEach((line) => {
      const color = line.kind === "cost"
        ? COLORS.amber
        : line.kind === "takeProfit"
          ? COLORS.green
          : COLORS.red;
      drawDashedHorizontal(context, priceRect.left, priceRect.left + priceRect.width, priceY(line.price), color, line.kind === "cost" ? 2.4 : 1.6);
    });

    drawDashedHorizontal(
      context,
      priceRect.left,
      priceRect.left + priceRect.width,
      priceY(chartSeries.currentCandle.close),
      COLORS.blue,
      1.4,
      [2, 4],
    );
    drawTradeMarkers(
      context,
      state,
      chartSeries.candles,
      chartSeries.cursor,
      chartStartIndex,
      xAt,
      priceY,
    );
  });

  replayPriceLines.forEach((line) => {
    const color = line.kind === "cost"
      ? COLORS.amber
      : line.kind === "takeProfit"
        ? COLORS.green
        : COLORS.red;
    drawAxisTag(
      context,
      plotRight + 3,
      priceY(line.price),
      `${String(line.label)} ${formatPrice(line.price)}`,
      color,
    );
  });
  drawAxisTag(
    context,
    plotRight + 3,
    priceY(chartSeries.currentCandle.close),
    formatPrice(chartSeries.currentCandle.close),
    COLORS.blue,
  );

  panes.forEach((pane) => {
    drawIndicatorPane(
      context,
      pane,
      state,
      chartSeries.candles,
      visibleCandles,
      chartStartIndex,
      xAt,
      orderFlow,
      plotLeft,
      plotRight,
    );
  });
  drawTimeAxis(
    context,
    visibleCandles,
    xAt,
    plotBottom - 20,
    plotLeft,
    plotRight,
  );
}

function drawIndicatorLegend(
  context: CanvasRenderingContext2D,
  state: NormalizedFrameState,
  orderFlowAvailable: boolean,
  x: number,
  y: number,
) {
  const items: Array<[string, string]> = [];
  if (state.indicatorVisibility.ema21) items.push(["EMA21", COLORS.orange]);
  if (state.indicatorVisibility.ema200) items.push(["EMA200", COLORS.purple]);
  if (state.indicatorVisibility.volume) items.push(["成交量", COLORS.green]);
  if (state.indicatorVisibility.openInterest && state.openInterest.length) {
    items.push(["OI", COLORS.blue]);
  }
  if (state.indicatorVisibility.delta && orderFlowAvailable) {
    items.push(["Delta", COLORS.red]);
  }
  if (state.indicatorVisibility.cvd && orderFlowAvailable) {
    items.push(["CVD", COLORS.teal]);
  }

  context.font = `500 12px ${FONT_FAMILY}`;
  context.textAlign = "left";
  let cursor = x;
  for (const [label, color] of items) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(cursor, y - 4, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = COLORS.muted;
    context.fillText(label, cursor + 8, y);
    cursor += context.measureText(label).width + 27;
  }
}

function drawPriceGrid(
  context: CanvasRenderingContext2D,
  rect: { left: number; top: number; width: number; height: number },
  min: number,
  max: number,
) {
  context.font = `400 12px ${FONT_FAMILY}`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  for (let index = 0; index <= 5; index += 1) {
    const ratio = index / 5;
    const y = rect.top + ratio * rect.height;
    context.strokeStyle = COLORS.grid;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(rect.left, Math.round(y) + 0.5);
    context.lineTo(rect.left + rect.width, Math.round(y) + 0.5);
    context.stroke();
    context.fillStyle = COLORS.muted;
    context.fillText(formatPrice(max - ratio * (max - min)), rect.left + rect.width + 7, y);
  }
}

function drawLineSeries(
  context: CanvasRenderingContext2D,
  points: Array<{ time: number; value: number }>,
  chartStartIndex: number,
  chartCandles: readonly ReplayVideoCandle[],
  chartCursor: number,
  xAt: (index: number) => number,
  yAt: (value: number) => number,
  color: string,
  width: number,
) {
  if (points.length < 2) return;
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineJoin = "round";
  context.beginPath();
  let moved = false;
  points.forEach((point) => {
    const sourceIndex = locateCandleBySeconds(chartCandles, point.time);
    const visibleIndex = sourceIndex - chartStartIndex;
    if (visibleIndex < 0 || visibleIndex > chartCursor - chartStartIndex) return;
    const x = xAt(visibleIndex);
    const y = yAt(point.value);
    if (!moved) {
      context.moveTo(x, y);
      moved = true;
    } else {
      context.lineTo(x, y);
    }
  });
  if (moved) context.stroke();
}

function drawTradeMarkers(
  context: CanvasRenderingContext2D,
  state: NormalizedFrameState,
  chartCandles: readonly ReplayVideoCandle[],
  chartCursor: number,
  chartStartIndex: number,
  xAt: (index: number) => number,
  priceY: (price: number) => number,
) {
  if (!state.hasEntered) return;

  const stackCountByCandleAndSide = new Map<string, number>();
  state.tradeSnapshot.events.forEach((event) => {
    if (event.timeMs > state.replayTimeMs) return;
    const index = locateCandleByMilliseconds(chartCandles, event.timeMs);
    if (index < chartStartIndex || index > chartCursor) return;
    const stackKey = `${index}:${event.side}`;
    const stackIndex = stackCountByCandleAndSide.get(stackKey) ?? 0;
    stackCountByCandleAndSide.set(stackKey, stackIndex + 1);
    const horizontalOffsets = [0, -10, 10];
    const horizontalOffset = horizontalOffsets[stackIndex % horizontalOffsets.length];
    const verticalStack = Math.floor(stackIndex / horizontalOffsets.length);
    const isBuy = event.side === "buy";
    drawTradeArrow(
      context,
      xAt(index - chartStartIndex) + horizontalOffset,
      priceY(event.price),
      isBuy ? "BUY" : "SELL",
      isBuy,
      verticalStack,
    );
  });
}

function drawTradeArrow(
  context: CanvasRenderingContext2D,
  x: number,
  priceY: number,
  label: "BUY" | "SELL",
  pointsUp: boolean,
  stackIndex = 0,
) {
  const color = pointsUp ? COLORS.green : COLORS.red;
  const stackOffset = stackIndex * 24;
  const y = pointsUp
    ? priceY + 31 + stackOffset
    : priceY - 31 - stackOffset;
  context.fillStyle = color;
  context.beginPath();
  if (pointsUp) {
    context.moveTo(x, y - 18);
    context.lineTo(x - 8, y - 6);
    context.lineTo(x - 3, y - 6);
    context.lineTo(x - 3, y + 8);
    context.lineTo(x + 3, y + 8);
    context.lineTo(x + 3, y - 6);
    context.lineTo(x + 8, y - 6);
  } else {
    context.moveTo(x, y + 18);
    context.lineTo(x - 8, y + 6);
    context.lineTo(x - 3, y + 6);
    context.lineTo(x - 3, y - 8);
    context.lineTo(x + 3, y - 8);
    context.lineTo(x + 3, y + 6);
    context.lineTo(x + 8, y + 6);
  }
  context.closePath();
  context.fill();

  context.font = `800 11px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = color;
  context.fillText(label, x, pointsUp ? y + 19 : y - 19);
}

function drawIndicatorPane(
  context: CanvasRenderingContext2D,
  pane: Pane,
  state: NormalizedFrameState,
  chartCandles: readonly ReplayVideoCandle[],
  candles: ReplayVideoCandle[],
  chartStartIndex: number,
  xAt: (index: number) => number,
  orderFlow: ReturnType<typeof buildReplayOrderFlowSeries>,
  left: number,
  right: number,
) {
  context.fillStyle = COLORS.white;
  context.fillRect(left, pane.top, right - left, pane.height);
  context.strokeStyle = COLORS.grid;
  context.beginPath();
  context.moveTo(left, pane.top + 0.5);
  context.lineTo(right, pane.top + 0.5);
  context.stroke();

  if (pane.key === "volume") {
    const values = candles.map((candle) => candle.volume);
    drawHistogram(
      context,
      values,
      candles.map((candle) => candle.close >= candle.open),
      xAt,
      pane,
      false,
    );
    drawPaneLabel(context, pane, `成交量 ${formatCompact(values.at(-1) ?? 0)}`);
    return;
  }

  if (pane.key === "openInterest") {
    const visible = getReplayOpenInterestPoints(
      state.openInterest,
      state.replayTimeMs,
    ).filter(
      (point) =>
        point.time >= chartCandles[chartStartIndex].time &&
        point.time <= candles.at(-1)!.time,
    );
    drawTimedLine(
      context,
      visible.map((point) => ({ time: point.time, value: point.openInterest })),
      chartCandles[chartStartIndex].time,
      candles.at(-1)!.time,
      pane,
      left,
      right,
      COLORS.blue,
    );
    drawPaneLabel(
      context,
      pane,
      `OI ${formatCompact(visible.at(-1)?.openInterest ?? 0)}`,
    );
    return;
  }

  const data = pane.key === "delta" ? orderFlow.delta : orderFlow.cvd;
  const byTime = new Map(data.map((point) => [point.time, point.value]));
  const values = candles.map((candle) => byTime.get(candle.time) ?? null);
  if (pane.key === "delta") {
    drawSignedHistogram(context, values, xAt, pane);
  } else {
    const points = values.flatMap((value, index) =>
      value === null ? [] : [{ x: xAt(index), value }],
    );
    drawIndexedLine(context, points, pane, COLORS.teal);
  }
  const latest = data.at(-1)?.value;
  drawPaneLabel(
    context,
    pane,
    `${pane.label} ${latest === undefined ? "—" : formatCompact(latest)}`,
  );
}

function drawHistogram(
  context: CanvasRenderingContext2D,
  values: number[],
  positive: boolean[],
  xAt: (index: number) => number,
  pane: Pane,
  signed: boolean,
) {
  const max = Math.max(1e-12, ...values.map((value) => Math.abs(value)));
  const baseline = signed ? pane.top + pane.height / 2 : pane.top + pane.height - 5;
  const usableHeight = signed ? pane.height / 2 - 8 : pane.height - 14;
  const width = Math.max(2, Math.min(10, 1180 / Math.max(1, values.length) * 0.55));
  values.forEach((value, index) => {
    const height = Math.abs(value) / max * usableHeight;
    context.fillStyle = positive[index]
      ? "rgba(48, 196, 135, 0.62)"
      : "rgba(239, 101, 114, 0.62)";
    context.fillRect(
      xAt(index) - width / 2,
      signed && value >= 0 ? baseline - height : baseline - height,
      width,
      Math.max(1, height),
    );
  });
}

function drawSignedHistogram(
  context: CanvasRenderingContext2D,
  values: Array<number | null>,
  xAt: (index: number) => number,
  pane: Pane,
) {
  const clean = values.flatMap((value) => value === null ? [] : [value]);
  const max = Math.max(1e-12, ...clean.map((value) => Math.abs(value)));
  const baseline = pane.top + pane.height / 2;
  const usableHeight = pane.height / 2 - 6;
  context.strokeStyle = COLORS.grid;
  context.beginPath();
  context.moveTo(54, baseline + 0.5);
  context.lineTo(1340, baseline + 0.5);
  context.stroke();
  const width = Math.max(2, Math.min(10, 1180 / Math.max(1, values.length) * 0.55));
  values.forEach((value, index) => {
    if (value === null) return;
    const height = Math.abs(value) / max * usableHeight;
    context.fillStyle = value >= 0
      ? "rgba(48, 196, 135, 0.75)"
      : "rgba(239, 101, 114, 0.75)";
    context.fillRect(
      xAt(index) - width / 2,
      value >= 0 ? baseline - height : baseline,
      width,
      Math.max(1, height),
    );
  });
}

function drawIndexedLine(
  context: CanvasRenderingContext2D,
  points: Array<{ x: number; value: number }>,
  pane: Pane,
  color: string,
) {
  if (points.length < 2) return;
  const [min, max] = paddedRange(points.map((point) => point.value), 0.08);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => {
    const y = valueToY(point.value, min, max, pane.top + 6, pane.height - 12);
    if (index === 0) context.moveTo(point.x, y);
    else context.lineTo(point.x, y);
  });
  context.stroke();
}

function drawTimedLine(
  context: CanvasRenderingContext2D,
  points: Array<{ time: number; value: number }>,
  firstTime: number,
  lastTime: number,
  pane: Pane,
  left: number,
  right: number,
  color: string,
) {
  if (points.length < 2) return;
  const [min, max] = paddedRange(points.map((point) => point.value), 0.08);
  const span = Math.max(1, lastTime - firstTime);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => {
    const x = left + clamp((point.time - firstTime) / span, 0, 1) * (right - left);
    const y = valueToY(point.value, min, max, pane.top + 6, pane.height - 12);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
}

function drawPaneLabel(
  context: CanvasRenderingContext2D,
  pane: Pane,
  text: string,
) {
  context.font = `600 12px ${FONT_FAMILY}`;
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = COLORS.muted;
  context.fillText(text, 60, pane.top + 7);
}

function drawTimeAxis(
  context: CanvasRenderingContext2D,
  candles: ReplayVideoCandle[],
  xAt: (index: number) => number,
  y: number,
  left: number,
  right: number,
) {
  context.strokeStyle = COLORS.grid;
  context.beginPath();
  context.moveTo(left, y - 9.5);
  context.lineTo(right, y - 9.5);
  context.stroke();
  context.fillStyle = COLORS.muted;
  context.font = `400 11px ${FONT_FAMILY}`;
  context.textBaseline = "middle";
  const tickCount = Math.min(6, candles.length);
  for (let tick = 0; tick < tickCount; tick += 1) {
    const index = tickCount === 1
      ? 0
      : Math.round(tick / (tickCount - 1) * (candles.length - 1));
    const x = xAt(index);
    context.textAlign = tick === 0 ? "left" : tick === tickCount - 1 ? "right" : "center";
    context.fillText(formatAxisTime(candles[index].time), x, y + 6);
  }
}

function drawMultiTimeframePanels(
  context: CanvasRenderingContext2D,
  state: NormalizedFrameState,
) {
  const panelHeight = 264;
  state.secondaryTimeframes.forEach((label, index) => {
    drawTimeframeChart(
      context,
      label,
      resolveVideoChartSeries(state, label),
      state,
      1450,
      108 + index * 285,
      438,
      panelHeight,
    );
  });
}

function drawTimeframeChart(
  context: CanvasRenderingContext2D,
  label: ReplayVideoTimeframe,
  chartSeries: ReplayVideoChartSeries,
  state: NormalizedFrameState,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  context.fillStyle = COLORS.white;
  roundedRect(context, x, y, width, height, 16);
  context.fill();
  context.strokeStyle = COLORS.border;
  context.lineWidth = 1;
  context.stroke();

  const replayContext = buildFixedReplayContext(chartSeries.candles, {
    cursor: chartSeries.cursor,
    replayTimeMs: state.replayTimeMs,
    currentCandle: chartSeries.currentCandle,
    visibleCandles: 30,
  });
  const visibleCandles = replayContext.candles;
  const current = visibleCandles.at(-1)!;
  const plot = {
    left: x + 18,
    top: y + 48,
    width: width - 74,
    height: height - 76,
  };

  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = COLORS.ink;
  context.font = `750 17px ${FONT_FAMILY}`;
  context.fillText(label, x + 18, y + 27);
  context.fillStyle = COLORS.muted;
  context.font = `500 12px ${FONT_FAMILY}`;
  context.fillText(
    `${visibleCandles.length} 根 · 收 ${formatPrice(current.close)}`,
    x + 62,
    y + 27,
  );

  const [priceMin, priceMax] = paddedRange(
    visibleCandles.flatMap((candle) => [candle.high, candle.low]),
    0.09,
  );
  const priceY = (value: number) =>
    valueToY(value, priceMin, priceMax, plot.top, plot.height);
  for (let index = 0; index <= 3; index += 1) {
    const ratio = index / 3;
    const gridY = plot.top + plot.height * ratio;
    context.strokeStyle = COLORS.grid;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(plot.left, Math.round(gridY) + 0.5);
    context.lineTo(plot.left + plot.width, Math.round(gridY) + 0.5);
    context.stroke();
  }

  const candleStep = plot.width / replayContext.slotCount;
  const candleWidth = Math.max(2, Math.min(8, candleStep * 0.58));
  const xAt = (index: number) =>
    plot.left +
    (replayContext.paddingSlots + index + 0.5) * candleStep;

  clipRect(context, plot.left, plot.top, plot.width, plot.height, () => {
    visibleCandles.forEach((candle, index) => {
      const candleX = xAt(index);
      const tone = state.indicatorVisibility.volumeColoring
        ? getReplayVideoCandleTone(
            chartSeries.candles,
            replayContext.startIndex + index,
            chartSeries.cursor,
            chartSeries.currentCandle,
            state.volumeColoringConfig,
          )
        : null;
      context.strokeStyle = COLORS.ink;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(candleX, priceY(candle.high));
      context.lineTo(candleX, priceY(candle.low));
      context.stroke();

      const bodyTop = Math.min(priceY(candle.open), priceY(candle.close));
      const bodyHeight = Math.max(
        1,
        Math.abs(priceY(candle.open) - priceY(candle.close)),
      );
      context.fillStyle = replayVideoCandleFill(
        tone,
        candle.close >= candle.open,
      );
      context.strokeStyle = COLORS.ink;
      context.fillRect(
        candleX - candleWidth / 2,
        bodyTop,
        candleWidth,
        bodyHeight,
      );
      context.strokeRect(
        candleX - candleWidth / 2,
        bodyTop,
        candleWidth,
        bodyHeight,
      );
    });

    drawDashedHorizontal(
      context,
      plot.left,
      plot.left + plot.width,
      priceY(current.close),
      COLORS.blue,
      1.2,
      [2, 4],
    );
  });

  context.fillStyle = COLORS.blue;
  context.font = `650 10px ${FONT_FAMILY}`;
  context.textAlign = "left";
  context.fillText(
    formatPrice(current.close),
    plot.left + plot.width + 5,
    priceY(current.close),
  );
}

function getTimeframeAggregator(
  candles: NormalizedReplayVideoCandle[],
): ReplayTimeframeAggregator {
  const cached = TIMEFRAME_AGGREGATOR_CACHE.get(candles);
  if (cached) return cached;
  const aggregator = createReplayTimeframeAggregator(candles, {
    maxCandlesPerTimeframe: 240,
  });
  TIMEFRAME_AGGREGATOR_CACHE.set(candles, aggregator);
  return aggregator;
}

function drawPositionBar(
  context: CanvasRenderingContext2D,
  state: NormalizedFrameState,
) {
  const { positionState } = state;
  const palette = state.trade.side === "long"
    ? LONG_POSITION_COLORS
    : SHORT_POSITION_COLORS;
  const primaryColor = palette[0];

  context.textAlign = "left";
  context.textBaseline = "middle";
  context.font = `700 11px ${FONT_FAMILY}`;
  context.fillStyle = positionState.ratio > 0 ? primaryColor : "#8193a5";
  drawFittedText(
    context,
    formatVideoPositionLabel(positionState),
    POSITION_BAR_LABEL_X,
    POSITION_BAR_Y + POSITION_BAR_HEIGHT / 2,
    POSITION_BAR_TRACK_X - POSITION_BAR_LABEL_X - 10,
  );

  context.fillStyle = "#263444";
  roundedRect(
    context,
    POSITION_BAR_TRACK_X,
    POSITION_BAR_Y,
    POSITION_BAR_TRACK_WIDTH,
    POSITION_BAR_HEIGHT,
    POSITION_BAR_HEIGHT / 2,
  );
  context.fill();
  context.strokeStyle = "#34485d";
  context.lineWidth = 1;
  context.stroke();

  if (positionState.ratio <= 0 || positionState.segments.length === 0) return;

  context.save();
  roundedRect(
    context,
    POSITION_BAR_TRACK_X,
    POSITION_BAR_Y,
    POSITION_BAR_TRACK_WIDTH,
    POSITION_BAR_HEIGHT,
    POSITION_BAR_HEIGHT / 2,
  );
  context.clip();

  let segmentX = POSITION_BAR_TRACK_X;
  positionState.segments.forEach((segment, index) => {
    const segmentWidth = Math.max(
      0,
      Math.min(
        POSITION_BAR_TRACK_X + POSITION_BAR_TRACK_WIDTH - segmentX,
        POSITION_BAR_TRACK_WIDTH * segment.ratio,
      ),
    );
    if (segmentWidth <= 0) return;

    context.fillStyle = palette[segment.colorIndex % palette.length];
    context.fillRect(
      segmentX,
      POSITION_BAR_Y,
      segmentWidth,
      POSITION_BAR_HEIGHT,
    );
    segmentX += segmentWidth;

    if (
      index < positionState.segments.length - 1 &&
      segmentX < POSITION_BAR_TRACK_X + POSITION_BAR_TRACK_WIDTH
    ) {
      context.fillStyle = "rgba(9, 15, 22, 0.5)";
      context.fillRect(
        Math.max(POSITION_BAR_TRACK_X, segmentX - 0.5),
        POSITION_BAR_Y,
        1,
        POSITION_BAR_HEIGHT,
      );
    }
  });
  context.restore();
}

function formatVideoPositionLabel(positionState: ReplayPositionState) {
  if (positionState.ratio <= 0) return "空仓 · 0";
  if (positionState.ratio >= 1) return "满仓 · 1/1";
  if (positionState.label.endsWith("%")) {
    return `仓位 · ${positionState.label}`;
  }
  return `仓位 · ${positionState.label} · ${Math.round(positionState.ratio * 100)}%`;
}

function drawProgress(context: CanvasRenderingContext2D, state: NormalizedFrameState) {
  const x = 32;
  const y = 968;
  const width = 1856;
  const height = 80;
  context.fillStyle = COLORS.header;
  roundedRect(context, x, y, width, height, 14);
  context.fill();
  context.strokeStyle = COLORS.border;
  context.stroke();

  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = "#dfe8f1";
  context.font = `700 15px ${FONT_FAMILY}`;
  context.fillText("视频回放进度", x + 22, y + 24);
  context.fillStyle = "#8193a5";
  context.font = `500 13px ${FONT_FAMILY}`;
  context.fillText(
    `第 ${state.safeIndex - state.rangeStart + 1} / ${state.rangeEnd - state.rangeStart + 1} 根 K 线 · 单根进度 ${Math.round(state.phase * 100)}%`,
    x + 150,
    y + 24,
  );

  const trackX = x + 22;
  const trackY = y + 48;
  const trackWidth = width - 44;
  const events = buildVisibleVideoProgressEvents(state);
  const currentBarPosition = state.safeIndex + state.phase;
  const recentEvent = events
    .filter((event) => {
      const distance = currentBarPosition - (event.cursor + event.phase);
      return distance >= 0 && distance <= 0.38;
    })
    .at(-1);

  if (recentEvent) {
    drawProgressCallout(
      context,
      x + width - 642,
      y + 9,
      620,
      recentEvent.label,
      recentEvent.color,
      recentEvent.timeMs,
    );
  } else {
    context.textAlign = "right";
    context.fillStyle = "#8193a5";
    context.fillText(
      `${formatDateTime(state.replayTimeMs)} · ${Math.round(state.progress * 100)}%`,
      x + width - 22,
      y + 24,
    );
  }

  context.fillStyle = "#263444";
  roundedRect(context, trackX, trackY, trackWidth, 10, 5);
  context.fill();
  context.fillStyle = COLORS.amber;
  roundedRect(context, trackX, trackY, Math.max(8, trackWidth * state.progress), 10, 5);
  context.fill();

  events.forEach((event) => {
    const ratio = clamp(
      (event.cursor - state.rangeStart + event.phase) /
        Math.max(1, state.rangeEnd - state.rangeStart + 1),
      0,
      1,
    );
    const nodeX = trackX + trackWidth * ratio;
    const isRecent = recentEvent?.id === event.id;
    drawProgressNode(
      context,
      nodeX,
      trackY + 5,
      event.color,
      isRecent,
    );
  });
}

type VideoProgressEvent = {
  id: string;
  timeMs: number;
  cursor: number;
  phase: number;
  color: string;
  label: string;
};

function buildVisibleVideoProgressEvents(
  state: NormalizedFrameState,
): VideoProgressEvent[] {
  if (!state.hasEntered) return [];

  const events: VideoProgressEvent[] = [];
  const entryPhase = getCandlePhaseAtTime(
    state.candles[state.safeEntryIndex],
    state.entryTimeMs,
    state.candles[state.safeEntryIndex + 1],
  );
  if (
    state.safeEntryIndex >= state.rangeStart &&
    state.safeEntryIndex <= state.rangeEnd &&
    state.entryTimeMs <= state.replayTimeMs
  ) {
    const entryIsBuy = state.trade.side === "long";
    events.push({
      id: `video-entry-${state.trade.id ?? state.trade.symbol}`,
      timeMs: state.entryTimeMs,
      cursor: state.safeEntryIndex,
      phase: entryPhase,
      color: entryIsBuy ? COLORS.green : COLORS.red,
      label: `${entryIsBuy ? "BUY" : "SELL"} 入场 ${formatQuantity(state.trade.quantity)} @ ${formatPrice(state.trade.entryPrice)}`,
    });
  }

  let progressNodes: ReplayProgressNode[] = [];
  try {
    progressNodes = buildReplayProgressNodes(
      state.trade,
      state.candles,
      state.safeEntryIndex,
    );
  } catch {
    progressNodes = [];
  }

  progressNodes
    .filter(
      (node) =>
        node.timeMs <= state.replayTimeMs &&
        node.cursor >= state.rangeStart &&
        node.cursor <= state.rangeEnd,
    )
    .forEach((node) => {
      events.push({
        id: node.id,
        timeMs: node.timeMs,
        cursor: node.cursor,
        phase: node.phase,
        color: progressNodeColor(node, state.trade.side),
        label: node.actions.map(formatVideoProgressAction).join("；"),
      });
    });

  return events.sort(
    (left, right) =>
      left.timeMs - right.timeMs ||
      left.cursor - right.cursor ||
      left.phase - right.phase,
  );
}

function formatVideoProgressAction(action: ReplayProgressAction) {
  if ("exitPrice" in action) {
    const closeLabel = action.type === "full-close" ? "全部平仓" : "部分平仓";
    return `${closeLabel} ${formatQuantity(action.quantity)} @ ${formatPrice(action.exitPrice)}`;
  }

  const riskLabel = action.riskKind === "takeProfit" ? "TP" : "SL";
  const executionLabel = action.executionType
    ? ` ${action.executionType.toUpperCase()}`
    : "";
  if (action.type === "risk-modified") {
    return `修改 ${riskLabel}${executionLabel} ${formatPrice(action.previousPrice)} → ${formatPrice(action.price)}`;
  }
  if (action.type === "risk-created") {
    return `设置 ${riskLabel}${executionLabel} @ ${formatPrice(action.price)}`;
  }
  if (action.type === "risk-cancelled") {
    return `撤销 ${riskLabel}${executionLabel}`;
  }
  if (action.type === "risk-expired") {
    return `${riskLabel}${executionLabel} 已过期`;
  }
  return `触发 ${riskLabel}${executionLabel} @ ${formatPrice(action.price)}`;
}

function progressNodeColor(
  node: ReplayProgressNode,
  side: ReplayVideoTrade["side"],
) {
  if (node.tone === "takeProfit") return COLORS.green;
  if (node.tone === "stopLoss") return COLORS.red;
  if (node.tone === "modified") return COLORS.blue;
  if (node.tone === "cancelled") return "#8d9bad";
  if (node.tone === "expired") return COLORS.amber;
  return side === "long" ? COLORS.red : COLORS.green;
}

function drawProgressCallout(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  label: string,
  color: string,
  timeMs: number,
) {
  context.fillStyle = COLORS.panelMuted;
  roundedRect(context, x, y, width, 30, 9);
  context.fill();
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.stroke();
  context.fillStyle = color;
  context.beginPath();
  context.arc(x + 15, y + 15, 5, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#e8f0f7";
  context.font = `650 13px ${FONT_FAMILY}`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  drawFittedText(
    context,
    `${formatEventClock(timeMs)} · ${label}`,
    x + 28,
    y + 16,
    width - 40,
  );
}

function drawProgressNode(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  highlighted = false,
) {
  if (highlighted) {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 11, 0, Math.PI * 2);
    context.stroke();
  }
  context.fillStyle = COLORS.header;
  context.beginPath();
  context.arc(x, y, 8, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, 5, 0, Math.PI * 2);
  context.fill();
}

function drawAxisTag(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  value: string,
  color: string,
) {
  context.font = `700 11px ${FONT_FAMILY}`;
  const width = Math.min(80, Math.max(48, context.measureText(value).width + 10));
  context.fillStyle = color;
  roundedRect(context, x, y - 10, width, 20, 3);
  context.fill();
  context.fillStyle = COLORS.white;
  context.textAlign = "center";
  context.textBaseline = "middle";
  drawFittedText(context, value, x + width / 2, y, width - 6, "center");
}

function drawDashedHorizontal(
  context: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  y: number,
  color: string,
  width: number,
  dash: number[] = [7, 6],
) {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.setLineDash(dash);
  context.beginPath();
  context.moveTo(x1, y);
  context.lineTo(x2, y);
  context.stroke();
  context.restore();
}

function paneLabel(key: Pane["key"]) {
  if (key === "volume") return "成交量";
  if (key === "openInterest") return "OI";
  if (key === "delta") return "Delta";
  return "CVD";
}

function getNormalizedCandles(
  candles: readonly ReplayVideoCandle[],
): NormalizedReplayVideoCandle[] {
  const cached = NORMALIZED_CANDLE_CACHE.get(candles);
  if (cached) return cached;
  const base = candles.map((candle, index) =>
    normalizeCandle(candle, index),
  );
  const normalized = base.map((candle, index) => {
    const previous = base[index - 1];
    const next = base[index + 1];
    const intervalMs = next
      ? (next.time - candle.time) * 1000
      : previous
        ? (candle.time - previous.time) * 1000
        : 5 * 60_000;
    return {
      ...candle,
      closeTime: candle.closeTime ??
        candle.time * 1000 + Math.max(1, intervalMs) - 1,
    };
  });
  NORMALIZED_CANDLE_CACHE.set(candles, normalized);
  return normalized;
}

function normalizeCandle(candle: ReplayVideoCandle, index: number): ReplayVideoCandle {
  const values = [
    candle?.time,
    candle?.open,
    candle?.high,
    candle?.low,
    candle?.close,
    candle?.volume,
  ].map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`第 ${index + 1} 根 K 线包含无效数值`);
  }
  const [time, open, high, low, close, volume] = values;
  if (time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) {
    throw new RangeError(`第 ${index + 1} 根 K 线数值超出有效范围`);
  }
  const takerBuyVolume = candle.takerBuyVolume === undefined
    ? undefined
    : Number(candle.takerBuyVolume);
  if (
    takerBuyVolume !== undefined &&
    (!Number.isFinite(takerBuyVolume) ||
      takerBuyVolume < 0 ||
      takerBuyVolume > volume)
  ) {
    throw new RangeError(`第 ${index + 1} 根 K 线主动买入量无效`);
  }
  const closeTime = candle.closeTime === undefined
    ? undefined
    : Number(candle.closeTime);
  if (closeTime !== undefined && !Number.isFinite(closeTime)) {
    throw new TypeError(`第 ${index + 1} 根 K 线收盘时间无效`);
  }
  return {
    ...candle,
    time,
    open,
    high,
    low,
    close,
    volume,
    ...(takerBuyVolume === undefined
      ? {}
      : { takerBuyVolume }),
    ...(closeTime === undefined
      ? {}
      : { closeTime }),
  };
}

function paddedRange(values: number[], paddingRatio: number): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return [0, 1];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = Math.max(max - min, Math.abs(max) * 0.002, 1e-9);
  return [min - span * paddingRatio, max + span * paddingRatio];
}

function valueToY(
  value: number,
  min: number,
  max: number,
  top: number,
  height: number,
) {
  return top + (1 - (value - min) / Math.max(1e-12, max - min)) * height;
}

function locateCandleBySeconds(candles: readonly ReplayVideoCandle[], time: number) {
  return locateCandleByMilliseconds(candles, time * 1000);
}

function locateCandleByMilliseconds(
  candles: readonly ReplayVideoCandle[],
  timeMs: number,
) {
  let result = 0;
  for (let index = 0; index < candles.length; index += 1) {
    if (candles[index].time * 1000 > timeMs) break;
    result = index;
  }
  return result;
}

const REPLAY_VIDEO_TIMEFRAMES = new Set<ReplayVideoTimeframe>([
  "5m",
  "15m",
  "1H",
  "4H",
  "1D",
]);

function normalizeVideoTimeframe(
  value: unknown,
  label: string,
): ReplayVideoTimeframe {
  if (!REPLAY_VIDEO_TIMEFRAMES.has(value as ReplayVideoTimeframe)) {
    throw new TypeError(`${label}无效`);
  }
  return value as ReplayVideoTimeframe;
}

function normalizeSecondaryTimeframes(
  value: unknown,
): ReplayVideoSecondaryTimeframes {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("视频必须选择三个副图周期");
  }
  return [
    normalizeVideoTimeframe(value[0], "视频副图 1 周期"),
    normalizeVideoTimeframe(value[1], "视频副图 2 周期"),
    normalizeVideoTimeframe(value[2], "视频副图 3 周期"),
  ];
}

function normalizeVideoVolumeColoringConfig(
  value: ReplayVideoVolumeColoringConfig,
): ReplayVideoVolumeColoringConfig {
  const rvolPeriod = Number(value?.rvolPeriod);
  const lookback = Number(value?.lookback);
  if (!Number.isInteger(rvolPeriod) || rvolPeriod <= 0) {
    throw new TypeError("视频 RVOL 周期必须是正整数");
  }
  if (!Number.isInteger(lookback) || lookback <= 0) {
    throw new TypeError("视频量能回看周期必须是正整数");
  }
  return { rvolPeriod, lookback };
}

function sideLabel(side: string) {
  return side === "long" ? "做多 LONG" : "做空 SHORT";
}

function formatSpeed(speed: number) {
  return `${Number.isInteger(speed) ? speed.toFixed(0) : speed.toFixed(1)}× 速度`;
}

function formatPrice(value: number) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const digits = absolute >= 1000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatQuantity(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}

function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(timeMs: number) {
  if (!Number.isFinite(timeMs)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timeMs));
}

function formatEventClock(timeMs: number) {
  if (!Number.isFinite(timeMs)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timeMs));
}

function formatAxisTime(timeSeconds: number) {
  if (!Number.isFinite(timeSeconds)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timeSeconds * 1000));
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
  align: CanvasTextAlign = "left",
) {
  const text = String(value);
  context.textAlign = align;
  if (context.measureText(text).width <= maxWidth) {
    context.fillText(text, x, y);
    return;
  }
  let shortened = text;
  while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  context.fillText(`${shortened}…`, x, y);
}

function clipRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  callback: () => void,
) {
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  callback();
  context.restore();
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.min(Math.max(Math.trunc(Number(value)), min), max);
}
