/**
 * 计算标准 EMA：首个完整周期使用 SMA 作为种子，样本不足的位置返回 null。
 */
export {
  buildReplayXinMentorshipSeries,
  calculateXinMentorship,
  createXinMentorshipAccumulator,
} from "./xin-mentorship.mjs";

export function calculateEmaSeries(prices, period) {
  if (!Number.isInteger(period) || period <= 0) {
    throw new TypeError("EMA 周期必须是正整数");
  }
  if (!Array.isArray(prices)) {
    throw new TypeError("EMA 价格必须是数组");
  }

  const normalizedPrices = prices.map(Number);
  if (normalizedPrices.some((price) => !Number.isFinite(price))) {
    throw new TypeError("EMA 价格必须是有效数字");
  }

  const result = Array.from({ length: normalizedPrices.length }, () => null);
  if (normalizedPrices.length < period) return result;

  let ema = normalizedPrices
    .slice(0, period)
    .reduce((sum, price) => sum + price, 0) / period;
  result[period - 1] = ema;

  const multiplier = 2 / (period + 1);
  for (let index = period; index < normalizedPrices.length; index += 1) {
    ema = (normalizedPrices[index] - ema) * multiplier + ema;
    result[index] = ema;
  }
  return result;
}

/**
 * 构造回放时刻可见的 EMA；未来 K 线不会进入计算，当前 K 线使用部分收盘价。
 */
export function buildReplayEmaSeries(candles, cursor, currentClose, period) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const safeCursor = Math.min(
    Math.max(Number.isFinite(cursor) ? Math.trunc(cursor) : 0, 0),
    candles.length - 1,
  );
  const replayCandles = candles.slice(0, safeCursor + 1);
  const closes = replayCandles.map((candle, index) =>
    index === safeCursor ? Number(currentClose) : Number(candle.close),
  );
  const values = calculateEmaSeries(closes, period);

  return values.flatMap((value, index) => {
    const time = Number(replayCandles[index]?.time);
    return value === null || !Number.isFinite(time)
      ? []
      : [{ time, value }];
  });
}

export const DEFAULT_VOLUME_COLORING_CONFIG = Object.freeze({
  rvolPeriod: 20,
  lookback: 30,
  highRvolMultiplier: 3,
  lowRvolMultiplier: 0.25,
});

function normalizeVolumeColoringPeriod(value, fallback, label) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label}必须是正整数`);
  }
  return normalized;
}

function normalizeVolumeColoringConfig(options = {}) {
  return {
    rvolPeriod: normalizeVolumeColoringPeriod(
      options.rvolPeriod,
      DEFAULT_VOLUME_COLORING_CONFIG.rvolPeriod,
      "RVOL 周期",
    ),
    lookback: normalizeVolumeColoringPeriod(
      options.lookback,
      DEFAULT_VOLUME_COLORING_CONFIG.lookback,
      "回看周期",
    ),
    highRvolMultiplier: DEFAULT_VOLUME_COLORING_CONFIG.highRvolMultiplier,
    lowRvolMultiplier: DEFAULT_VOLUME_COLORING_CONFIG.lowRvolMultiplier,
  };
}

function normalizeVolumeCandle(candle) {
  const time = Number(candle?.time);
  const open = Number(candle?.open);
  const close = Number(candle?.close);
  const volume = Number(candle?.volume);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume) ||
    volume < 0
  ) {
    throw new TypeError("量能染色需要有效的时间、开收盘价和非负成交量");
  }
  return { time, open, close, volume };
}

function calculateVolumeCandleColorPoint(candles, index, config) {
  const candle = candles[index];
  let rvol = null;
  if (index >= config.rvolPeriod) {
    const referenceVolumes = candles.slice(
      index - config.rvolPeriod,
      index,
    );
    const averageVolume = referenceVolumes.reduce(
      (sum, item) => sum + item.volume,
      0,
    ) / config.rvolPeriod;
    rvol = averageVolume > 0 ? candle.volume / averageVolume : null;
  }

  let isLookbackHigh = false;
  let isLookbackLow = false;
  if (index + 1 >= config.lookback) {
    const windowVolumes = candles
      .slice(index - config.lookback + 1, index + 1)
      .map((item) => item.volume);
    const highestVolume = Math.max(...windowVolumes);
    const lowestVolume = Math.min(...windowVolumes);
    if (highestVolume > lowestVolume) {
      isLookbackHigh = candle.volume === highestVolume;
      isLookbackLow = candle.volume === lowestVolume;
    }
  }

  const isRvolLow = rvol !== null && rvol <= config.lowRvolMultiplier;
  const isRvolHigh = rvol !== null && rvol > config.highRvolMultiplier;
  let tone = null;
  let trigger = null;
  if (isRvolLow || isLookbackLow) {
    tone = "low";
    trigger = isRvolLow ? "rvol-low" : "lookback-low";
  } else if (isRvolHigh || isLookbackHigh) {
    tone = candle.close >= candle.open ? "bullish" : "bearish";
    trigger = isRvolHigh ? "rvol-high" : "lookback-high";
  }

  return {
    time: candle.time,
    rvol,
    tone,
    trigger,
  };
}

/**
 * 按当前及此前 K 线计算成交量染色，不读取未来数据。
 * RVOL 的基准是当前 K 线之前 N 根的平均成交量；最高/最低量窗口包含当前 K 线。
 */
export function buildVolumeCandleColorSeries(candles, options = {}) {
  if (!Array.isArray(candles)) {
    throw new TypeError("量能染色 K 线必须是数组");
  }

  const config = normalizeVolumeColoringConfig(options);
  const normalizedCandles = candles.map(normalizeVolumeCandle);
  const points = normalizedCandles.map((_, index) =>
    calculateVolumeCandleColorPoint(normalizedCandles, index, config)
  );

  return { config, points };
}

/** 只计算指定 K 线的染色，供图表追加或更新最后一根时使用。 */
export function buildVolumeCandleColorPoint(candles, index, options = {}) {
  if (!Array.isArray(candles)) {
    throw new TypeError("量能染色 K 线必须是数组");
  }
  const safeIndex = Number(index);
  if (!Number.isInteger(safeIndex) || safeIndex < 0 || safeIndex >= candles.length) {
    throw new RangeError("量能染色 K 线索引超出范围");
  }
  const config = normalizeVolumeColoringConfig(options);
  const startIndex = Math.max(
    0,
    safeIndex - Math.max(config.rvolPeriod, config.lookback - 1),
  );
  const window = candles
    .slice(startIndex, safeIndex + 1)
    .map(normalizeVolumeCandle);
  return calculateVolumeCandleColorPoint(
    window,
    window.length - 1,
    config,
  );
}

/**
 * 使用 Binance K 线总成交量与主动买入量计算成交量 Delta。
 * 主动卖量 = 总成交量 - 主动买入量，因此 Delta = 2 × 主动买入量 - 总成交量。
 */
export function calculateVolumeDelta(volume, takerBuyVolume) {
  const normalizedVolume = Number(volume);
  const normalizedTakerBuyVolume = Number(takerBuyVolume);
  if (!Number.isFinite(normalizedVolume) || normalizedVolume < 0) {
    throw new TypeError("总成交量必须是有效的非负数字");
  }
  if (
    !Number.isFinite(normalizedTakerBuyVolume) ||
    normalizedTakerBuyVolume < 0 ||
    normalizedTakerBuyVolume > normalizedVolume
  ) {
    throw new TypeError("主动买量必须介于 0 和总成交量之间");
  }
  return normalizedTakerBuyVolume * 2 - normalizedVolume;
}

/**
 * 构造当前回放时刻可见的 Delta 与 CVD；未来 K 线不会进入累计。
 * Binance K 线只提供整根最终主动买量，因此当前 K 线完成前不展示其订单流结果。
 */
export function buildReplayOrderFlowSeries(candles, cursor, candlePhase) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { available: false, delta: [], cvd: [] };
  }
  const safeCursor = Math.min(
    Math.max(Number.isFinite(cursor) ? Math.trunc(cursor) : 0, 0),
    candles.length - 1,
  );
  const normalizedPhase = Math.min(
    Math.max(Number.isFinite(candlePhase) ? Number(candlePhase) : 0, 0),
    1,
  );
  const replayCandles = candles.slice(0, safeCursor + 1);

  if (replayCandles.some((candle) => candle?.takerBuyVolume === undefined)) {
    return { available: false, delta: [], cvd: [] };
  }

  const completedCandles = replayCandles.slice(
    0,
    normalizedPhase >= 1 ? replayCandles.length : Math.max(0, replayCandles.length - 1),
  );
  let cumulativeDelta = 0;
  const delta = [];
  const cvd = [];
  completedCandles.forEach((candle) => {
    const time = Number(candle?.time);
    if (!Number.isFinite(time)) {
      throw new TypeError("Delta K 线时间必须是有效数字");
    }
    const visibleDelta = calculateVolumeDelta(candle.volume, candle.takerBuyVolume);
    cumulativeDelta += visibleDelta;
    delta.push({ time, value: visibleDelta });
    cvd.push({ time, value: cumulativeDelta });
  });

  return { available: true, delta, cvd };
}
