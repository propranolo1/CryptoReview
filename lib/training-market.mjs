const BTC_FUTURES_HISTORY_START = Date.UTC(2020, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

const INTERVAL_MS = Object.freeze({
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
});

/**
 * 生成一次随机 BTCUSDT U 本位永续训练行情请求。
 * 随机数由调用方注入，便于测试；结束时间至少落后当前时间一天。
 */
export function createRandomTrainingRequest({
  now = Date.now(),
  random = Math.random(),
  interval = "15m",
  limit = 320,
  historyCandles = limit,
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new TypeError("当前时间必须是有效毫秒时间戳");
  }
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new RangeError("随机数必须位于 0（含）到 1（不含）之间");
  }
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new TypeError("不支持的训练时间框架");
  if (!Number.isInteger(limit) || limit < 120 || limit > 1000) {
    throw new RangeError("训练 K 线数量必须是 120 到 1000 的整数");
  }
  if (
    !Number.isInteger(historyCandles) ||
    historyCandles < limit ||
    historyCandles > 10_000
  ) {
    throw new RangeError("训练历史总量必须是不少于单页数量且不超过 10000 的整数");
  }

  const earliestEnd = BTC_FUTURES_HISTORY_START + intervalMs * historyCandles;
  const latestEnd = now - DAY_MS;
  if (latestEnd <= earliestEnd) {
    throw new RangeError("可用历史区间不足以生成训练片段");
  }
  const rawEndTime = earliestEnd + Math.floor((latestEnd - earliestEnd) * random);
  const endTime = Math.floor(rawEndTime / intervalMs) * intervalMs;
  const query = new URLSearchParams({
    symbol: "BTCUSDT",
    market: "binance-futures",
    interval,
    endTime: String(endTime),
    limit: String(limit),
  });

  return {
    symbol: "BTCUSDT",
    market: "binance-futures",
    interval,
    endTime,
    limit,
    url: `/api/market/klines?${query.toString()}`,
  };
}

/** 为初始训练窗口向更早时间分页读取历史 K 线。 */
export function createTrainingHistoryRequest({
  interval = "15m",
  endTime,
  limit = 1000,
} = {}) {
  if (!INTERVAL_MS[interval]) {
    throw new TypeError("不支持的训练时间框架");
  }
  if (!Number.isSafeInteger(endTime) || endTime <= 0) {
    throw new TypeError("训练历史结束时间必须是有效毫秒时间戳");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("训练历史分页数量必须是 1 到 1000 的整数");
  }
  const query = new URLSearchParams({
    symbol: "BTCUSDT",
    market: "binance-futures",
    interval,
    endTime: String(endTime),
    limit: String(limit),
  });
  return {
    symbol: "BTCUSDT",
    market: "binance-futures",
    interval,
    endTime,
    limit,
    url: `/api/market/klines?${query.toString()}`,
  };
}

/** 合并从新到旧取得的训练历史分页，并按 K 线开盘时间稳定去重。 */
export function mergeTrainingHistoryPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new RangeError("训练历史至少需要一页行情");
  }
  const candlesByTime = new Map();
  let source = "Binance Futures";
  pages.forEach((page, pageIndex) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new TypeError(`第 ${pageIndex + 1} 页训练历史格式无效`);
    }
    if (String(page.symbol ?? "").toUpperCase() !== "BTCUSDT") {
      throw new TypeError("训练历史必须来自 BTCUSDT");
    }
    if (!Array.isArray(page.candles)) {
      throw new TypeError(`第 ${pageIndex + 1} 页训练历史缺少 K 线数组`);
    }
    if (pageIndex === 0 && typeof page.source === "string") {
      source = page.source;
    }
    page.candles.forEach((candle, candleIndex) => {
      const time = Number(candle?.time);
      if (!Number.isFinite(time) || time <= 0) {
        throw new TypeError(`第 ${pageIndex + 1} 页第 ${candleIndex + 1} 根 K 线时间无效`);
      }
      if (!candlesByTime.has(time)) candlesByTime.set(time, candle);
    });
  });
  return {
    source,
    symbol: "BTCUSDT",
    candles: [...candlesByTime.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, candle]) => candle),
  };
}

/** 在一局训练仍有持仓且已走到当前片段末尾时，继续读取后续真实 K 线。 */
export function createTrainingContinuationRequest({
  interval = "15m",
  startTime,
  limit = 240,
} = {}) {
  if (!INTERVAL_MS[interval]) {
    throw new TypeError("不支持的训练时间框架");
  }
  if (!Number.isSafeInteger(startTime) || startTime <= 0) {
    throw new TypeError("续接开始时间必须是有效毫秒时间戳");
  }
  if (!Number.isInteger(limit) || limit < 20 || limit > 1000) {
    throw new RangeError("续接训练 K 线数量必须是 20 到 1000 的整数");
  }

  const query = new URLSearchParams({
    symbol: "BTCUSDT",
    market: "binance-futures",
    interval,
    startTime: String(startTime),
    limit: String(limit),
  });
  return {
    symbol: "BTCUSDT",
    market: "binance-futures",
    interval,
    startTime,
    limit,
    url: `/api/market/klines?${query.toString()}`,
  };
}

/**
 * 校验行情响应，并只保留一局训练所需的上下文与未来片段。
 */
export function prepareTrainingCandles(
  payload,
  { contextCandles = 80, trainingCandles = 160 } = {},
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("训练行情响应格式无效");
  }
  if (String(payload.symbol ?? "").toUpperCase() !== "BTCUSDT") {
    throw new TypeError("训练行情必须来自 BTCUSDT");
  }
  if (!Number.isInteger(contextCandles) || contextCandles < 20) {
    throw new RangeError("训练上下文至少需要 20 根 K 线");
  }
  if (!Number.isInteger(trainingCandles) || trainingCandles < 20) {
    throw new RangeError("每局训练至少需要 20 根后续 K 线");
  }
  if (!Array.isArray(payload.candles)) {
    throw new TypeError("训练行情缺少 K 线数组");
  }

  const required = contextCandles + trainingCandles;
  if (payload.candles.length < required) {
    throw new RangeError(`BTC 训练行情不足，需要至少 ${required} 根 K 线`);
  }
  const candles = payload.candles.slice(-required).map((candle, index) => {
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
      throw new TypeError(`第 ${index + 1} 根训练 K 线格式无效`);
    }
    const normalized = {
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      closeTime: Number(candle.closeTime),
    };
    if (
      !Object.values(normalized).every(Number.isFinite) ||
      normalized.time <= 0 ||
      normalized.closeTime <= 0 ||
      normalized.volume < 0 ||
      normalized.low > Math.min(normalized.open, normalized.close) ||
      normalized.high < Math.max(normalized.open, normalized.close)
    ) {
      throw new TypeError(`第 ${index + 1} 根训练 K 线价格无效`);
    }
    return normalized;
  });

  if (candles.some((candle, index) => index > 0 && candle.time <= candles[index - 1].time)) {
    throw new TypeError("训练 K 线时间必须严格递增");
  }

  return {
    source: typeof payload.source === "string" ? payload.source : "Binance Futures",
    symbol: "BTCUSDT",
    candles,
    initialCursor: contextCandles - 1,
  };
}

/**
 * 校验训练续接响应，并丢弃上游可能重复返回的边界 K 线。
 * 返回的数据仍只保存在本机内存中，由界面逐根揭示。
 */
export function prepareTrainingContinuationCandles(
  payload,
  { afterCloseTime } = {},
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("训练续接行情响应格式无效");
  }
  if (String(payload.symbol ?? "").toUpperCase() !== "BTCUSDT") {
    throw new TypeError("训练续接行情必须来自 BTCUSDT");
  }
  if (!Number.isSafeInteger(afterCloseTime) || afterCloseTime <= 0) {
    throw new TypeError("训练续接边界时间无效");
  }
  if (!Array.isArray(payload.candles)) {
    throw new TypeError("训练续接行情缺少 K 线数组");
  }

  const candles = payload.candles.map((candle, index) =>
    normalizeContinuationCandle(candle, index),
  );
  if (candles.some((candle, index) => index > 0 && candle.time <= candles[index - 1].time)) {
    throw new TypeError("训练续接 K 线时间必须严格递增");
  }
  const newCandles = candles.filter((candle) => candle.time * 1000 > afterCloseTime);
  if (newCandles.length === 0) {
    throw new RangeError("Binance 没有返回新的 K 线，暂时无法继续训练");
  }

  return {
    source: typeof payload.source === "string" ? payload.source : "Binance Futures",
    symbol: "BTCUSDT",
    candles: newCandles,
  };
}

function normalizeContinuationCandle(candle, index) {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
    throw new TypeError(`第 ${index + 1} 根训练续接 K 线格式无效`);
  }
  const normalized = {
    time: Number(candle.time),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume),
    closeTime: Number(candle.closeTime),
  };
  if (
    !Object.values(normalized).every(Number.isFinite) ||
    normalized.time <= 0 ||
    normalized.closeTime <= 0 ||
    normalized.volume < 0 ||
    normalized.low > Math.min(normalized.open, normalized.close) ||
    normalized.high < Math.max(normalized.open, normalized.close)
  ) {
    throw new TypeError(`第 ${index + 1} 根训练续接 K 线价格无效`);
  }
  return normalized;
}
