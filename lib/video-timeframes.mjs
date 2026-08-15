const TIMEFRAME_SECONDS = Object.freeze({
  "15m": 15 * 60,
  "1H": 60 * 60,
  "4H": 4 * 60 * 60,
  "1D": 24 * 60 * 60,
});

export const VIDEO_REPLAY_CONTEXT_DEFAULTS = Object.freeze({
  visibleCandles: 80,
});

/**
 * 把当前回放时刻已经发生的 5 分钟行情聚合为高周期。
 *
 * cursor 之前只接收已经收盘的 K 线；cursor 对应的 K 线必须使用调用方传入
 * 的 currentCandle 部分状态。若调用方没有传入部分状态，则只暴露该根 K 线
 * 已知的开盘价和零成交量，避免读取完整 K 线的未来高低收数据。
 */
export function buildReplayTimeframeCandles(candles, options) {
  const sourceCandles = normalizeCandles(candles);
  const {
    cursor,
    replayTimeMs,
    currentCandle,
  } = normalizeReplayOptions(options, sourceCandles);

  const visibleCandles = [];
  for (let index = 0; index < cursor; index += 1) {
    const candle = sourceCandles[index];
    if (candle.closeTime <= replayTimeMs) {
      visibleCandles.push(candle);
    }
  }

  const sourceCurrent = sourceCandles[cursor];
  if (replayTimeMs >= sourceCurrent.time * 1000) {
    visibleCandles.push(
      currentCandle === undefined
        ? buildOpeningState(sourceCurrent, replayTimeMs)
        : normalizePartialCandle(currentCandle, sourceCurrent, replayTimeMs),
    );
  }

  return {
    "15m": aggregateCandles(visibleCandles, TIMEFRAME_SECONDS["15m"]),
    "1H": aggregateCandles(visibleCandles, TIMEFRAME_SECONDS["1H"]),
    "4H": aggregateCandles(visibleCandles, TIMEFRAME_SECONDS["4H"]),
    "1D": aggregateCandles(visibleCandles, TIMEFRAME_SECONDS["1D"]),
  };
}

/**
 * 为逐帧视频渲染创建一次性行情快照。
 *
 * 完整高周期桶只预计算一次；每一帧仅重算当前 1H/4H/1D 桶（最多分别
 * 12/48/288 根 5m K 线），避免录制时反复扫描整段行情。
 */
export function createReplayTimeframeAggregator(candles, options = undefined) {
  const sourceCandles = normalizeCandles(candles);
  const outputLimit = normalizeTimeframeOutputLimit(
    isRecord(options) ? options.maxCandlesPerTimeframe : undefined,
  );
  const caches = Object.fromEntries(
    Object.entries(TIMEFRAME_SECONDS).map(([label, intervalSeconds]) => [
      label,
      createTimeframeCache(sourceCandles, intervalSeconds),
    ]),
  );

  return Object.freeze({
    build(frameOptions) {
      const {
        cursor,
        replayTimeMs,
        currentCandle,
      } = normalizeReplayOptions(frameOptions, sourceCandles);
      const sourceCurrent = sourceCandles[cursor];
      const partial = currentCandle === undefined
        ? buildOpeningState(sourceCurrent, replayTimeMs)
        : normalizePartialCandle(currentCandle, sourceCurrent, replayTimeMs);

      return Object.freeze(
        Object.fromEntries(
          Object.entries(caches).map(([label, cache]) => [
            label,
            buildCachedTimeframe(
              sourceCandles,
              cache,
              cursor,
              replayTimeMs,
              partial,
              outputLimit,
            ),
          ]),
        ),
      );
    },
  });
}

/**
 * 返回固定槽位的回放上下文。
 *
 * 有足够历史数据时，当前 K 线固定处于最右侧，窗口向左携带历史 K 线；
 * 历史不足时通过 paddingSlots 保留相同绘图宽度，避免首帧蜡烛被放大。
 */
export function buildFixedReplayContext(candles, options = undefined) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError("视频回放上下文至少需要一根 K 线");
  }
  const normalizedOptions = isRecord(options) ? options : {};
  const visibleCandles = normalizeVisibleCandleCount(
    normalizedOptions.visibleCandles,
  );
  const cursor = normalizeCursor(normalizedOptions.cursor, candles.length);
  const startIndex = Math.max(0, cursor - visibleCandles + 1);
  const sourceCandles = normalizeCandleWindow(candles, startIndex, cursor);
  const contextCandles = sourceCandles.map(toPublicCandle);
  const sourceCurrent = sourceCandles[sourceCandles.length - 1];

  if (normalizedOptions.currentCandle !== undefined) {
    const replayTimeMs = finiteNumber(
      normalizedOptions.replayTimeMs ??
        sourceCurrent.closeTime,
      "当前回放时间",
    );
    contextCandles[contextCandles.length - 1] = toPublicCandle(
      normalizePartialCandle(
        normalizedOptions.currentCandle,
        sourceCurrent,
        replayTimeMs,
      ),
    );
  }

  const paddingSlots = visibleCandles - contextCandles.length;
  return {
    candles: contextCandles,
    startIndex,
    endIndex: cursor,
    slotCount: visibleCandles,
    paddingSlots,
    currentSlot: paddingSlots + contextCandles.length - 1,
  };
}

function createTimeframeCache(candles, intervalSeconds) {
  const bucketIndexes = new Array(candles.length);
  const bucketStartSourceIndexes = [];
  let previousBucketTime = null;

  for (let index = 0; index < candles.length; index += 1) {
    const bucketTime =
      Math.floor(candles[index].time / intervalSeconds) * intervalSeconds;
    if (bucketTime !== previousBucketTime) {
      bucketStartSourceIndexes.push(index);
      previousBucketTime = bucketTime;
    }
    bucketIndexes[index] = bucketStartSourceIndexes.length - 1;
  }

  return Object.freeze({
    intervalSeconds,
    bucketIndexes: Object.freeze(bucketIndexes),
    bucketStartSourceIndexes: Object.freeze(bucketStartSourceIndexes),
    fullBuckets: Object.freeze(
      aggregateCandles(candles, intervalSeconds).map((item) =>
        Object.freeze(item),
      ),
    ),
  });
}

function buildCachedTimeframe(
  sourceCandles,
  cache,
  cursor,
  replayTimeMs,
  partial,
  outputLimit,
) {
  const currentBucketIndex = cache.bucketIndexes[cursor];
  const firstBucketIndex = Math.max(
    0,
    currentBucketIndex - outputLimit + 1,
  );
  const result = cache.fullBuckets.slice(
    firstBucketIndex,
    currentBucketIndex,
  );
  const currentSources = [];
  const bucketStart = cache.bucketStartSourceIndexes[currentBucketIndex];

  for (let index = bucketStart; index < cursor; index += 1) {
    if (sourceCandles[index].closeTime <= replayTimeMs) {
      currentSources.push(sourceCandles[index]);
    }
  }
  currentSources.push(partial);
  const currentBucket = aggregateCandles(
    currentSources,
    cache.intervalSeconds,
  )[0];
  if (currentBucket) {
    result.push(Object.freeze(currentBucket));
  }
  return Object.freeze(result);
}

function aggregateCandles(candles, intervalSeconds) {
  const buckets = [];

  for (const candle of candles) {
    const bucketTime =
      Math.floor(candle.time / intervalSeconds) * intervalSeconds;
    let bucket = buckets.at(-1);

    if (!bucket || bucket.time !== bucketTime) {
      bucket = {
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        takerBuyVolume: candle.takerBuyVolume ?? 0,
        hasCompleteTakerBuyVolume: candle.takerBuyVolume !== undefined,
        closeTime: candle.closeTime,
      };
      buckets.push(bucket);
      continue;
    }

    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    bucket.close = candle.close;
    bucket.volume += candle.volume;
    bucket.takerBuyVolume += candle.takerBuyVolume ?? 0;
    bucket.hasCompleteTakerBuyVolume =
      bucket.hasCompleteTakerBuyVolume &&
      candle.takerBuyVolume !== undefined;
    bucket.closeTime = candle.closeTime;
  }

  return buckets.map((bucket) => ({
    time: bucket.time,
    open: bucket.open,
    high: bucket.high,
    low: bucket.low,
    close: bucket.close,
    volume: bucket.volume,
    ...(bucket.hasCompleteTakerBuyVolume
      ? { takerBuyVolume: bucket.takerBuyVolume }
      : {}),
    closeTime: bucket.closeTime,
  }));
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError("视频多时间框架至少需要一根 K 线");
  }

  const normalized = candles.map((candle, index) =>
    normalizeCandle(candle, index),
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].time <= normalized[index - 1].time) {
      throw new RangeError("K 线必须严格按时间升序排列");
    }
  }
  return normalized.map((candle, index) =>
    resolveCandleCloseTime(candle, normalized[index + 1]),
  );
}

function normalizeCandleWindow(candles, startIndex, endIndex) {
  const normalized = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const candle = normalizeCandle(candles[index], index);
    if (
      normalized.length > 0 &&
      candle.time <= normalized[normalized.length - 1].time
    ) {
      throw new RangeError("K 线必须严格按时间升序排列");
    }
    normalized.push(candle);
  }
  return normalized.map((candle, index) =>
    resolveCandleCloseTime(candle, normalized[index + 1]),
  );
}

function normalizeCandle(candle, index) {
  if (!isRecord(candle)) {
    throw new TypeError(`第 ${index + 1} 根 K 线必须是对象`);
  }

  const time = finiteNumber(candle.time, `第 ${index + 1} 根 K 线时间`);
  const open = finiteNumber(candle.open, `第 ${index + 1} 根 K 线开盘价`);
  const high = finiteNumber(candle.high, `第 ${index + 1} 根 K 线最高价`);
  const low = finiteNumber(candle.low, `第 ${index + 1} 根 K 线最低价`);
  const close = finiteNumber(candle.close, `第 ${index + 1} 根 K 线收盘价`);
  const volume = nonNegativeNumber(
    candle.volume,
    `第 ${index + 1} 根 K 线成交量`,
  );
  const closeTime =
    candle.closeTime === undefined ||
    candle.closeTime === null ||
    candle.closeTime === ""
      ? null
      : finiteNumber(candle.closeTime, `第 ${index + 1} 根 K 线收盘时间`);
  const takerBuyVolume =
    candle.takerBuyVolume === undefined ||
    candle.takerBuyVolume === null
      ? undefined
      : nonNegativeNumber(
          candle.takerBuyVolume,
          `第 ${index + 1} 根 K 线主动买入量`,
        );

  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new RangeError(`第 ${index + 1} 根 K 线的 OHLC 关系无效`);
  }
  if (takerBuyVolume !== undefined && takerBuyVolume > volume) {
    throw new RangeError(`第 ${index + 1} 根 K 线主动买入量不能大于成交量`);
  }
  if (closeTime !== null && closeTime < time * 1000) {
    throw new RangeError(`第 ${index + 1} 根 K 线收盘时间早于开盘时间`);
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    ...(takerBuyVolume === undefined ? {} : { takerBuyVolume }),
    closeTime,
  };
}

function resolveCandleCloseTime(candle, nextCandle) {
  const openTimeMs = candle.time * 1000;
  const inferredCloseTime =
    nextCandle === undefined
      ? openTimeMs + 5 * 60 * 1000 - 1
      : nextCandle.time * 1000 - 1;
  const closeTime = candle.closeTime ?? inferredCloseTime;
  if (closeTime < openTimeMs) {
    throw new RangeError("K 线收盘时间早于开盘时间");
  }
  if (
    nextCandle !== undefined &&
    closeTime >= nextCandle.time * 1000
  ) {
    throw new RangeError("相邻 K 线的时间范围不能重叠");
  }
  return {
    ...candle,
    closeTime,
  };
}

function normalizeReplayOptions(options, candles) {
  if (!isRecord(options)) {
    throw new TypeError("多时间框架回放参数必须是对象");
  }

  const cursor = normalizeCursor(options.cursor, candles.length);
  const replayTimeMs = finiteNumber(options.replayTimeMs, "当前回放时间");
  const currentOpenTime = candles[cursor].time * 1000;
  const currentCloseTime = candles[cursor].closeTime;
  if (replayTimeMs < currentOpenTime || replayTimeMs > currentCloseTime) {
    throw new RangeError("当前回放时间必须位于游标对应的 K 线内");
  }

  return {
    cursor,
    replayTimeMs,
    currentCandle: options.currentCandle,
  };
}

function normalizePartialCandle(value, sourceCandle, replayTimeMs) {
  if (!isRecord(value)) {
    throw new TypeError("当前部分 K 线必须是对象");
  }

  const open = finiteNumber(value.open, "当前部分 K 线开盘价");
  const high = finiteNumber(value.high, "当前部分 K 线最高价");
  const low = finiteNumber(value.low, "当前部分 K 线最低价");
  const close = finiteNumber(value.close, "当前部分 K 线收盘价");
  const volume = nonNegativeNumber(value.volume, "当前部分 K 线成交量");
  const takerBuyVolume =
    value.takerBuyVolume === undefined || value.takerBuyVolume === null
      ? undefined
      : nonNegativeNumber(value.takerBuyVolume, "当前部分 K 线主动买入量");

  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new RangeError("当前部分 K 线的 OHLC 关系无效");
  }
  if (takerBuyVolume !== undefined && takerBuyVolume > volume) {
    throw new RangeError("当前部分 K 线主动买入量不能大于成交量");
  }

  return {
    time: sourceCandle.time,
    open,
    high,
    low,
    close,
    volume,
    ...(takerBuyVolume === undefined ? {} : { takerBuyVolume }),
    closeTime: Math.min(replayTimeMs, sourceCandle.closeTime),
  };
}

function buildOpeningState(sourceCandle, replayTimeMs) {
  return {
    time: sourceCandle.time,
    open: sourceCandle.open,
    high: sourceCandle.open,
    low: sourceCandle.open,
    close: sourceCandle.open,
    volume: 0,
    ...(sourceCandle.takerBuyVolume === undefined
      ? {}
      : { takerBuyVolume: 0 }),
    closeTime: Math.min(replayTimeMs, sourceCandle.closeTime),
  };
}

function normalizeCursor(value, candleCount) {
  const cursor = finiteNumber(value, "K 线游标");
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= candleCount) {
    throw new RangeError("K 线游标超出行情范围");
  }
  return cursor;
}

function normalizeVisibleCandleCount(value) {
  if (value === undefined) {
    return VIDEO_REPLAY_CONTEXT_DEFAULTS.visibleCandles;
  }
  const count = finiteNumber(value, "可视 K 线数量");
  if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
    throw new RangeError("可视 K 线数量必须是 1 到 500 的整数");
  }
  return count;
}

function normalizeTimeframeOutputLimit(value) {
  if (value === undefined) return 80;
  const count = finiteNumber(value, "每个高周期最大 K 线数量");
  if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
    throw new RangeError("每个高周期最大 K 线数量必须是 1 到 500 的整数");
  }
  return count;
}

function toPublicCandle(candle) {
  return { ...candle };
}

function nonNegativeNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) {
    throw new RangeError(`${label}不能小于 0`);
  }
  return number;
}

function finiteNumber(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label}必须是有限数字`);
  }
  return number;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
