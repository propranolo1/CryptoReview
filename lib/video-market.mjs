const PAGE_LIMIT = 1000;
const MAX_PAGES = 32;

/**
 * 通过现有行情代理连续读取视频所需 K 线。
 * 每页以最后一根 closeTime + 1 继续，边界重复按开盘时间去重。
 */
export async function fetchVideoExportCandles({
  fetchImpl,
  symbol,
  interval,
  market,
  startTime,
  endTime,
  signal,
  endpoint = "/api/market/klines",
  maxPages = MAX_PAGES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("视频行情必须提供 fetch 实现");
  }
  const normalizedSymbol = String(symbol ?? "")
    .toUpperCase()
    .replace(/[\s/_-]/g, "");
  if (!/^[A-Z0-9]{5,24}$/.test(normalizedSymbol)) {
    throw new TypeError("视频行情交易对格式无效");
  }
  if (typeof interval !== "string" || interval.trim() === "") {
    throw new TypeError("视频行情时间框架无效");
  }
  if (market !== "binance" && market !== "binance-futures") {
    throw new TypeError("视频行情市场无效");
  }
  if (!Number.isSafeInteger(startTime) || startTime <= 0) {
    throw new TypeError("视频行情开始时间无效");
  }
  if (!Number.isSafeInteger(endTime) || endTime < startTime) {
    throw new TypeError("视频行情结束时间无效");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new RangeError(`视频行情分页上限必须是 1 到 ${MAX_PAGES}`);
  }

  const byTime = new Map();
  let nextStartTime = startTime;
  let source = market === "binance-futures" ? "Binance Futures" : "Binance Spot";
  let completed = false;

  for (let page = 0; page < maxPages; page += 1) {
    if (signal?.aborted) throw abortError();
    const query = new URLSearchParams({
      symbol: normalizedSymbol,
      interval: interval.trim(),
      market,
      startTime: String(nextStartTime),
      endTime: String(endTime),
      limit: String(PAGE_LIMIT),
    });
    const response = await fetchImpl(`${endpoint}?${query.toString()}`, { signal });
    const payload = await response.json();
    if (!response.ok || !payload || typeof payload !== "object") {
      const message = payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : "视频行情读取失败";
      throw new Error(message);
    }
    if (String(payload.symbol ?? "").toUpperCase() !== normalizedSymbol) {
      throw new TypeError("视频行情响应交易对不一致");
    }
    if (!Array.isArray(payload.candles)) {
      throw new TypeError("视频行情响应缺少 K 线数组");
    }
    if (typeof payload.source === "string" && payload.source.trim() !== "") {
      source = payload.source.trim();
    }
    if (payload.candles.length === 0) break;

    const pageCandles = payload.candles.map(normalizeCandle);
    pageCandles.sort((left, right) => left.time - right.time);
    let pageMaxCloseTime = Number.NEGATIVE_INFINITY;
    for (const candle of pageCandles) {
      pageMaxCloseTime = Math.max(pageMaxCloseTime, candle.closeTime);
      if (candle.closeTime >= startTime && candle.time * 1000 <= endTime) {
        byTime.set(candle.time, candle);
      }
    }

    if (pageMaxCloseTime >= endTime) {
      completed = true;
      break;
    }
    if (pageMaxCloseTime < nextStartTime) {
      throw new RangeError("视频行情分页没有继续向后推进");
    }
    const followingStart = Math.floor(pageMaxCloseTime) + 1;
    if (followingStart <= nextStartTime) {
      throw new RangeError("视频行情分页没有继续向后推进");
    }
    nextStartTime = followingStart;
  }

  const candles = [...byTime.values()].sort((left, right) => left.time - right.time);
  if (candles.length === 0) {
    throw new RangeError("没有取得可用于视频导出的 K 线");
  }
  if (!completed && nextStartTime < endTime) {
    const last = candles.at(-1);
    if (!last || last.closeTime < endTime) {
      throw new RangeError("视频行情分页没有覆盖所需结束时间");
    }
  }
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].time <= candles[index - 1].time) {
      throw new RangeError("视频行情 K 线时间必须严格递增");
    }
  }

  return { source, symbol: normalizedSymbol, interval: interval.trim(), candles };
}

function normalizeCandle(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`第 ${index + 1} 根视频 K 线格式无效`);
  }
  const candle = {
    time: Number(value.time),
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume),
    closeTime: Number(value.closeTime),
    ...(value.takerBuyVolume === undefined
      ? {}
      : { takerBuyVolume: Number(value.takerBuyVolume) }),
  };
  if (
    !Object.values(candle).every(Number.isFinite) ||
    candle.time <= 0 ||
    candle.closeTime < candle.time * 1000 ||
    candle.volume < 0 ||
    candle.low > Math.min(candle.open, candle.close) ||
    candle.high < Math.max(candle.open, candle.close) ||
    (candle.takerBuyVolume !== undefined && (
      candle.takerBuyVolume < 0 || candle.takerBuyVolume > candle.volume
    ))
  ) {
    throw new TypeError(`第 ${index + 1} 根视频 K 线价格无效`);
  }
  return candle;
}

function abortError() {
  return new DOMException("视频行情读取已取消", "AbortError");
}
