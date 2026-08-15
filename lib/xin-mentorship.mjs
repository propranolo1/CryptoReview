const DEFAULT_CONFIG = Object.freeze({
  wtChannelLength: 9,
  wtAverageLength: 12,
  wtMaLength: 3,
  overbought1: 53,
  overbought2: 60,
  oversold1: -53,
  oversold2: -60,
  rsiLength: 14,
  mfiPeriod: 60,
  mfiMultiplier: 150,
  aoFast: 5,
  aoSlow: 34,
  momentumLookback: 5,
  volumeConfirmation: true,
  volumeMaLength: 20,
});

/**
 * 复刻用户提供的 XIN Mentorship Pine Script 默认计算。
 * 返回与输入 K 线等长的不可变快照；尚未完成预热的位置使用 null。
 */
export function calculateXinMentorship(candles, options = {}) {
  const accumulator = createXinMentorshipAccumulator(options);
  normalizeCandles(candles).forEach((candle) => accumulator.append(candle));
  return accumulator.snapshot();
}

/**
 * 创建可追加、可替换最后一根 K 线的 XIN 增量计算器。
 * 高周期正在形成的最后一根 K 线变化时只回滚一个点，不重新扫描整段历史。
 */
export function createXinMentorshipAccumulator(options = {}) {
  const config = normalizeConfig(options);
  const normalizedCandles = [];
  const points = [];
  const wt1 = [];
  const wt2 = [];
  const rsi = [];
  const mfi = [];
  const ao = [];
  const momentum = [];
  const momentumDelta = [];
  const esaState = createNullableEmaAccumulator(config.wtChannelLength);
  const deviationEmaState = createNullableEmaAccumulator(config.wtChannelLength);
  const wt1State = createNullableEmaAccumulator(config.wtAverageLength);
  const wt2State = createNullableSmaAccumulator(config.wtMaLength);
  const rsiState = createRsiAccumulator(config.rsiLength);
  const mfiState = createNullableSmaAccumulator(config.mfiPeriod);
  const aoFastState = createNullableSmaAccumulator(config.aoFast);
  const aoSlowState = createNullableSmaAccumulator(config.aoSlow);
  const momentumState = createNullableEmaAccumulator(3);
  const volumeAverageState = createNullableSmaAccumulator(config.volumeMaLength);

  let previousTop = null;
  let currentTop = null;
  let previousBottom = null;
  let currentBottom = null;
  let totalBuys = 0;
  let totalSells = 0;
  let winBuys = 0;
  let winSells = 0;
  let lastBuyPrice = null;
  let lastSellPrice = null;
  let totalBuyPercent = 0;
  let totalSellPercent = 0;
  let previousPreBearWarning = false;
  let previousPreBullWarning = false;
  let lastCheckpoint = null;

  const statefulSeries = [
    normalizedCandles,
    points,
    wt1,
    wt2,
    rsi,
    mfi,
    ao,
    momentum,
    momentumDelta,
  ];
  const statefulAccumulators = [
    esaState,
    deviationEmaState,
    wt1State,
    wt2State,
    rsiState,
    mfiState,
    aoFastState,
    aoSlowState,
    momentumState,
    volumeAverageState,
  ];

  function captureState() {
    return {
      lengths: statefulSeries.map((series) => series.length),
      accumulators: statefulAccumulators.map((accumulator) => accumulator.snapshot()),
      previousTop,
      currentTop,
      previousBottom,
      currentBottom,
      totalBuys,
      totalSells,
      winBuys,
      winSells,
      lastBuyPrice,
      lastSellPrice,
      totalBuyPercent,
      totalSellPercent,
      previousPreBearWarning,
      previousPreBullWarning,
    };
  }

  function restoreState(checkpoint) {
    statefulSeries.forEach((series, index) => {
      series.length = checkpoint.lengths[index];
    });
    statefulAccumulators.forEach((accumulator, index) => {
      accumulator.restore(checkpoint.accumulators[index]);
    });
    previousTop = checkpoint.previousTop;
    currentTop = checkpoint.currentTop;
    previousBottom = checkpoint.previousBottom;
    currentBottom = checkpoint.currentBottom;
    totalBuys = checkpoint.totalBuys;
    totalSells = checkpoint.totalSells;
    winBuys = checkpoint.winBuys;
    winSells = checkpoint.winSells;
    lastBuyPrice = checkpoint.lastBuyPrice;
    lastSellPrice = checkpoint.lastSellPrice;
    totalBuyPercent = checkpoint.totalBuyPercent;
    totalSellPercent = checkpoint.totalSellPercent;
    previousPreBearWarning = checkpoint.previousPreBearWarning;
    previousPreBullWarning = checkpoint.previousPreBullWarning;
  }

  function append(candle) {
    const checkpoint = captureState();
    const index = normalizedCandles.length;
    const normalized = normalizeCandle(candle, index);
    normalizedCandles.push(normalized);

    const hlc3 = (normalized.high + normalized.low + normalized.close) / 3;
    const hl2 = (normalized.high + normalized.low) / 2;
    const esa = esaState.push(hlc3);
    const deviation = esa === null ? null : Math.abs(hlc3 - esa);
    const averageDeviation = deviationEmaState.push(deviation);
    const channelIndex = averageDeviation === null || averageDeviation === 0
      ? null
      : (hlc3 - esa) / (0.015 * averageDeviation);
    const wt1Value = wt1State.push(channelIndex);
    wt1.push(wt1Value);
    const wt2Value = wt2State.push(wt1Value);
    wt2.push(wt2Value);
    const rsiValue = rsiState.push(normalized.close);
    rsi.push(rsiValue);
    const range = normalized.high - normalized.low;
    const mfiRaw = range === 0
      ? null
      : ((normalized.close - normalized.open) / range) * config.mfiMultiplier;
    const mfiValue = mfiState.push(mfiRaw) ?? 0;
    mfi.push(mfiValue);
    const aoFast = aoFastState.push(hl2);
    const aoSlow = aoSlowState.push(hl2);
    const aoValue = aoFast === null || aoSlow === null ? null : aoFast - aoSlow;
    ao.push(aoValue);
    let aoNorm = null;
    if (aoValue !== null) {
      let maximum = 0;
      for (let cursor = Math.max(0, index - 99); cursor <= index; cursor += 1) {
        if (ao[cursor] !== null) maximum = Math.max(maximum, Math.abs(ao[cursor]));
      }
      aoNorm = maximum === 0 ? 0 : (aoValue / maximum) * 30;
    }
    const momentumScore =
      wt1Value === null ||
      wt2Value === null ||
      rsiValue === null ||
      aoNorm === null
        ? null
        : (
            (wt1Value - wt2Value) * 0.4 +
            (rsiValue - 50) * 0.15 +
            aoNorm * 0.25 +
            mfiValue * 0.2
          );
    const momentumValue = momentumState.push(momentumScore);
    momentum.push(momentumValue);
    const previousMomentum = momentum[index - 1];
    const delta = momentumValue === null || index === 0 || previousMomentum === null
      ? null
      : momentumValue - previousMomentum;
    momentumDelta.push(delta);
    const priorMomentumDelta = momentumDelta[index - 1];
    const acceleration = delta === null || index === 0 || priorMomentumDelta === null
      ? null
      : delta - priorMomentumDelta;
    const volumeAverage = volumeAverageState.push(normalized.volume);
    const crossUp = crossedUp(wt1, wt2, index);
    const crossDown = crossedDown(wt1, wt2, index);
    const volumeOk =
      !config.volumeConfirmation ||
      (
        volumeAverage !== null &&
        normalized.volume > volumeAverage * 0.75
      );
    const topFractal =
      index >= 4 &&
      finite(wt2[index - 4]) &&
      wt2[index - 4] < wt2[index - 2] &&
      wt2[index - 3] < wt2[index - 2] &&
      wt2[index - 2] > wt2[index - 1] &&
      wt2[index - 2] > wt2[index];
    const bottomFractal =
      index >= 4 &&
      finite(wt2[index - 4]) &&
      wt2[index - 4] > wt2[index - 2] &&
      wt2[index - 3] > wt2[index - 2] &&
      wt2[index - 2] < wt2[index - 1] &&
      wt2[index - 2] < wt2[index];

    if (topFractal) {
      previousTop = currentTop;
      currentTop = {
        wt: wt2[index - 2],
        price: normalizedCandles[index - 2].high,
      };
    }
    if (bottomFractal) {
      previousBottom = currentBottom;
      currentBottom = {
        wt: wt2[index - 2],
        price: normalizedCandles[index - 2].low,
      };
    }
    const bearishDivergence = Boolean(
      topFractal &&
      previousTop &&
      currentTop.price > previousTop.price &&
      currentTop.wt < previousTop.wt &&
      currentTop.wt > 0,
    );
    const bullishDivergence = Boolean(
      bottomFractal &&
      previousBottom &&
      currentBottom.price < previousBottom.price &&
      currentBottom.wt > previousBottom.wt &&
      currentBottom.wt < 0,
    );
    const regularBuy = Boolean(
      crossUp &&
      finite(wt2Value) &&
      wt2Value <= config.oversold1 &&
      finite(delta) &&
      delta > 0 &&
      volumeOk,
    );
    const strongBuy = Boolean(
      crossUp &&
      finite(wt2Value) &&
      wt2Value <= config.oversold2 &&
      finite(acceleration) &&
      acceleration > 0 &&
      volumeOk &&
      finite(rsiValue) &&
      finite(rsi[index - 1]) &&
      rsiValue > rsi[index - 1] &&
      mfiValue > (mfi[index - 1] ?? 0),
    );
    const goldBuy = Boolean(
      crossUp &&
      finite(wt2Value) &&
      wt2Value <= config.oversold2 &&
      bullishDivergence &&
      finite(rsiValue) &&
      rsiValue < 35,
    );
    const regularSell = Boolean(
      crossDown &&
      finite(wt2Value) &&
      wt2Value >= config.overbought1 &&
      finite(delta) &&
      delta < 0 &&
      volumeOk,
    );
    const strongSell = Boolean(
      crossDown &&
      finite(wt2Value) &&
      wt2Value >= config.overbought2 &&
      finite(acceleration) &&
      acceleration < 0 &&
      volumeOk &&
      finite(rsiValue) &&
      finite(rsi[index - 1]) &&
      rsiValue < rsi[index - 1] &&
      mfiValue < (mfi[index - 1] ?? 0),
    );
    const previousDelta = momentumDelta[index - 1];
    const twoBackDelta = momentumDelta[index - 2];
    const bearishWeakness = Boolean(
      finite(wt1Value) &&
      wt1Value > config.overbought1 * 0.7 &&
      finite(delta) &&
      finite(previousDelta) &&
      finite(twoBackDelta) &&
      delta < 0 &&
      previousDelta < twoBackDelta &&
      finite(acceleration) &&
      acceleration < 0,
    );
    const bullishStrength = Boolean(
      finite(wt1Value) &&
      wt1Value < config.oversold1 * 0.7 &&
      finite(delta) &&
      finite(previousDelta) &&
      finite(twoBackDelta) &&
      delta > 0 &&
      previousDelta > twoBackDelta &&
      finite(acceleration) &&
      acceleration > 0,
    );
    const preBearWarning = Boolean(
      finite(wt1Value) &&
      finite(wt2Value) &&
      wt1Value > config.overbought1 &&
      finite(acceleration) &&
      acceleration < -0.5 &&
      finite(delta) &&
      delta < 0 &&
      wt1Value > wt2Value,
    );
    const preBullWarning = Boolean(
      finite(wt1Value) &&
      finite(wt2Value) &&
      wt1Value < config.oversold1 &&
      finite(acceleration) &&
      acceleration > 0.5 &&
      finite(delta) &&
      delta > 0 &&
      wt1Value < wt2Value,
    );
    const anyBuy = regularBuy || strongBuy || goldBuy;
    const anySell = regularSell || strongSell;
    const showPreBearWarning = preBearWarning && !previousPreBearWarning;
    const showPreBullWarning = preBullWarning && !previousPreBullWarning;
    previousPreBearWarning = preBearWarning;
    previousPreBullWarning = preBullWarning;

    if (anyBuy) {
      if (lastSellPrice !== null) {
        const percent = ((lastSellPrice - normalized.close) / lastSellPrice) * 100;
        totalSellPercent += percent;
        if (normalized.close < lastSellPrice) winSells += 1;
        lastSellPrice = null;
      }
      lastBuyPrice = normalized.close;
      totalBuys += 1;
    }
    if (anySell) {
      if (lastBuyPrice !== null) {
        const percent = ((normalized.close - lastBuyPrice) / lastBuyPrice) * 100;
        totalBuyPercent += percent;
        if (normalized.close > lastBuyPrice) winBuys += 1;
        lastBuyPrice = null;
      }
      lastSellPrice = normalized.close;
      totalSells += 1;
    }

    const point = {
      time: normalized.time,
      wt1: clean(wt1Value),
      wt2: clean(wt2Value),
      mfi: clean(mfiValue),
      momentum: clean(momentum[index] === null ? null : momentum[index] * 2),
      momentumDelta: clean(delta),
      rsi: clean(rsiValue),
      acceleration: clean(acceleration),
      signal: goldBuy
        ? "gold-buy"
        : strongBuy
          ? "strong-buy"
          : regularBuy
            ? "buy"
            : strongSell
              ? "strong-sell"
              : regularSell
                ? "sell"
                : null,
      preBearWarning: showPreBearWarning,
      preBullWarning: showPreBullWarning,
      bearishWeakness,
      bullishStrength,
      bearishDivergence,
      bullishDivergence,
      divergenceTime: (bearishDivergence || bullishDivergence) && index >= 2
        ? normalizedCandles[index - 2].time
        : null,
      divergenceValue: bearishDivergence || bullishDivergence
        ? clean(wt2[index - 2])
        : null,
    };
    points.push(point);
    lastCheckpoint = checkpoint;
    return point;
  }

  function replaceLast(candle) {
    if (lastCheckpoint === null || normalizedCandles.length === 0) {
      throw new RangeError("XIN Mentorship 没有可替换的最后一根 K 线");
    }
    restoreState(lastCheckpoint);
    return append(candle);
  }

  function snapshot() {
    const lastPoint = [...points].reverse().find((point) => finite(point.wt1));
    return {
      config,
      points: [...points],
      status: statusFromWt(lastPoint?.wt1 ?? null, config),
      summary: {
        totalBuys,
        totalSells,
        buyWinRate: totalBuys === 0 ? 0 : (winBuys / totalBuys) * 100,
        sellWinRate: totalSells === 0 ? 0 : (winSells / totalSells) * 100,
        averageBuyPercent: totalBuys === 0 ? 0 : totalBuyPercent / totalBuys,
        averageSellPercent: totalSells === 0 ? 0 : totalSellPercent / totalSells,
      },
    };
  }

  return Object.freeze({
    config,
    append,
    replaceLast,
    snapshot,
    get length() {
      return normalizedCandles.length;
    },
  });
}

/** 构造当前回放时刻可见的 XIN 指标，未来 K 线不会进入计算。 */
export function buildReplayXinMentorshipSeries(
  candles,
  cursor,
  currentCandle,
  options = {},
) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return calculateXinMentorship([], options);
  }
  const safeCursor = Math.min(
    Math.max(Number.isFinite(cursor) ? Math.trunc(cursor) : 0, 0),
    candles.length - 1,
  );
  const visible = candles.slice(0, safeCursor + 1).map((candle, index) =>
    index === safeCursor && currentCandle
      ? { ...candle, ...currentCandle, time: candle.time }
      : candle,
  );
  return calculateXinMentorship(visible, options);
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError("XIN Mentorship K 线必须是数组");
  }
  return candles.map((candle, index) => normalizeCandle(candle, index));
}

function normalizeCandle(candle, index) {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
    throw new TypeError(`第 ${index + 1} 根 XIN K 线必须是对象`);
  }
  const normalized = {
    time: finiteNumber(candle.time, `第 ${index + 1} 根 K 线时间`),
    open: positiveNumber(candle.open, `第 ${index + 1} 根开盘价`),
    high: positiveNumber(candle.high, `第 ${index + 1} 根最高价`),
    low: positiveNumber(candle.low, `第 ${index + 1} 根最低价`),
    close: positiveNumber(candle.close, `第 ${index + 1} 根收盘价`),
    volume: nonNegativeNumber(candle.volume, `第 ${index + 1} 根成交量`),
  };
  if (
    normalized.high < Math.max(normalized.open, normalized.close) ||
    normalized.low > Math.min(normalized.open, normalized.close)
  ) {
    throw new RangeError(`第 ${index + 1} 根 XIN K 线高低价无效`);
  }
  return normalized;
}

function normalizeConfig(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("XIN Mentorship 配置必须是对象");
  }
  const config = { ...DEFAULT_CONFIG, ...options };
  for (const key of [
    "wtChannelLength",
    "wtAverageLength",
    "wtMaLength",
    "rsiLength",
    "mfiPeriod",
    "aoFast",
    "aoSlow",
    "momentumLookback",
    "volumeMaLength",
  ]) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new RangeError(`XIN Mentorship ${key} 必须是正整数`);
    }
  }
  for (const key of [
    "overbought1",
    "overbought2",
    "oversold1",
    "oversold2",
    "mfiMultiplier",
  ]) {
    if (!Number.isFinite(config[key])) {
      throw new TypeError(`XIN Mentorship ${key} 必须是有效数字`);
    }
  }
  config.volumeConfirmation = Boolean(config.volumeConfirmation);
  return config;
}

function createNullableEmaAccumulator(period) {
  const multiplier = 2 / (period + 1);
  let window = [];
  let ema = null;
  return {
    push(value) {
      if (!finite(value)) {
        window = [];
        ema = null;
        return null;
      }
      if (ema === null) {
        window.push(value);
        if (window.length < period) return null;
        if (window.length > period) window.shift();
        ema = window.reduce((sum, item) => sum + item, 0) / period;
      } else {
        ema = (value - ema) * multiplier + ema;
      }
      return ema;
    },
    snapshot() {
      return { window: [...window], ema };
    },
    restore(snapshot) {
      window = [...snapshot.window];
      ema = snapshot.ema;
    },
  };
}

function createNullableSmaAccumulator(period) {
  let window = [];
  return {
    push(value) {
      window.push(value);
      if (window.length > period) window.shift();
      if (window.length < period || window.some((item) => !finite(item))) {
        return null;
      }
      return window.reduce((sum, item) => sum + item, 0) / period;
    },
    snapshot() {
      return { window: [...window] };
    },
    restore(snapshot) {
      window = [...snapshot.window];
    },
  };
}

function createRsiAccumulator(period) {
  let index = -1;
  let previousClose = null;
  let gains = 0;
  let losses = 0;
  let averageGain = null;
  let averageLoss = null;
  return {
    push(close) {
      index += 1;
      if (index === 0) {
        previousClose = close;
        return null;
      }
      const change = close - previousClose;
      previousClose = close;
      if (index <= period) {
        gains += Math.max(change, 0);
        losses += Math.max(-change, 0);
        if (index < period) return null;
        averageGain = gains / period;
        averageLoss = losses / period;
      } else {
        averageGain =
          (averageGain * (period - 1) + Math.max(change, 0)) / period;
        averageLoss =
          (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
      }
      return rsiValue(averageGain, averageLoss);
    },
    snapshot() {
      return {
        index,
        previousClose,
        gains,
        losses,
        averageGain,
        averageLoss,
      };
    },
    restore(snapshot) {
      index = snapshot.index;
      previousClose = snapshot.previousClose;
      gains = snapshot.gains;
      losses = snapshot.losses;
      averageGain = snapshot.averageGain;
      averageLoss = snapshot.averageLoss;
    },
  };
}

function rsiValue(averageGain, averageLoss) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function crossedUp(left, right, index) {
  return (
    index > 0 &&
    finite(left[index]) &&
    finite(right[index]) &&
    finite(left[index - 1]) &&
    finite(right[index - 1]) &&
    left[index] > right[index] &&
    left[index - 1] <= right[index - 1]
  );
}

function crossedDown(left, right, index) {
  return (
    index > 0 &&
    finite(left[index]) &&
    finite(right[index]) &&
    finite(left[index - 1]) &&
    finite(right[index - 1]) &&
    left[index] < right[index] &&
    left[index - 1] >= right[index - 1]
  );
}

function statusFromWt(value, config) {
  if (!finite(value)) return "unavailable";
  if (value > config.overbought2) return "extreme-overbought";
  if (value > config.overbought1) return "overbought";
  if (value < config.oversold2) return "extreme-oversold";
  if (value < config.oversold1) return "oversold";
  return value > 0 ? "bullish" : "bearish";
}

function clean(value) {
  return finite(value) ? Number(value.toFixed(8)) : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}必须是有效数字`);
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new RangeError(`${label}必须大于 0`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) throw new RangeError(`${label}不能小于 0`);
  return number;
}
