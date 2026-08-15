const QUANTITY_EPSILON = 1e-10;
const BASE_FRAME_DURATION_MS = 100;

export const VIDEO_EXPORT_DEFAULTS = Object.freeze({
  preEntryCandles: 10,
  postExitCandles: 100,
  playbackSpeed: 1,
  framesPerCandle: 12,
});

export const VIDEO_EXPORT_RESOLUTION = Object.freeze({
  width: 1920,
  height: 1080,
});

/**
 * 将界面表单值转换成稳定的视频导出配置。
 *
 * K 线数量必须是非负整数；播放速度必须大于 0；每根 K 线帧数必须是
 * 1 到 120 的整数，避免错误输入生成体积异常的帧计划。
 */
export function normalizeVideoExportConfig(input = undefined) {
  if (input === undefined) {
    return { ...VIDEO_EXPORT_DEFAULTS };
  }
  if (!isRecord(input)) {
    throw new TypeError("视频导出配置必须是对象");
  }

  return {
    preEntryCandles: normalizeNonNegativeInteger(
      readConfigValue(input, "preEntryCandles"),
      VIDEO_EXPORT_DEFAULTS.preEntryCandles,
      "入场前 K 线数量",
    ),
    postExitCandles: normalizeNonNegativeInteger(
      readConfigValue(input, "postExitCandles"),
      VIDEO_EXPORT_DEFAULTS.postExitCandles,
      "平仓后 K 线数量",
    ),
    playbackSpeed: normalizePositiveNumber(
      readConfigValue(input, "playbackSpeed"),
      VIDEO_EXPORT_DEFAULTS.playbackSpeed,
      "播放速度",
    ),
    framesPerCandle: normalizeBoundedPositiveInteger(
      readConfigValue(input, "framesPerCandle"),
      VIDEO_EXPORT_DEFAULTS.framesPerCandle,
      "每根 K 线帧数",
      120,
    ),
  };
}

/**
 * 根据入场时间和最终平仓时间定位视频需要的完整 K 线窗口。
 *
 * 本函数不会静默截断前后 K 线。数据不足时显式报错，调用方可据此继续
 * 拉取行情，保证导出视频严格符合用户填写的数量。
 */
export function resolveVideoExportWindow(trade, candles, inputConfig = undefined) {
  const config = normalizeVideoExportConfig(inputConfig);
  const normalizedCandles = validateCandles(candles);
  const {
    entryTimeMs,
    finalExitTimeMs,
  } = resolveClosedTradeTimes(trade);

  const entryIndex = locateContainingCandle(
    normalizedCandles,
    entryTimeMs,
    "入场时间没有对应的 K 线",
  );
  const finalExitIndex = locateContainingCandle(
    normalizedCandles,
    finalExitTimeMs,
    "最终平仓时间没有对应的 K 线",
  );

  if (finalExitIndex < entryIndex) {
    throw new RangeError("最终平仓 K 线不能早于入场 K 线");
  }

  const startIndex = entryIndex - config.preEntryCandles;
  if (startIndex < 0) {
    const available = entryIndex;
    throw new RangeError(
      `入场前 K 线不足：需要 ${config.preEntryCandles} 根，当前只有 ${available} 根`,
    );
  }

  const endIndex = finalExitIndex + config.postExitCandles;
  if (endIndex >= normalizedCandles.length) {
    const available = normalizedCandles.length - finalExitIndex - 1;
    throw new RangeError(
      `平仓后 K 线不足：需要 ${config.postExitCandles} 根，当前只有 ${available} 根`,
    );
  }

  return {
    entryIndex,
    finalExitIndex,
    startIndex,
    endIndex,
    candleCount: endIndex - startIndex + 1,
    entryTimeMs,
    finalExitTimeMs,
    preEntryCandles: config.preEntryCandles,
    postExitCandles: config.postExitCandles,
  };
}

/**
 * 为所选窗口生成确定性的 K 线内部阶段。
 *
 * 默认每根 K 线使用 12 个阶段，和当前复盘一致。每个阶段的基础持续时间
 * 是 100ms，播放倍速只改变持续时间，不会减少阶段或跳过 K 线。
 */
export function buildVideoExportFramePlan(
  candles,
  range,
  inputConfig = undefined,
) {
  const config = normalizeVideoExportConfig(inputConfig);
  const normalizedCandles = validateCandles(candles);
  const normalizedRange = validateRange(range, normalizedCandles.length);
  const frameDurationMs = BASE_FRAME_DURATION_MS / config.playbackSpeed;
  const frameCount = normalizedRange.candleCount * config.framesPerCandle;

  if (!Number.isSafeInteger(frameCount)) {
    throw new RangeError("视频帧数量超出安全范围");
  }

  const frames = [];
  for (
    let candleIndex = normalizedRange.startIndex;
    candleIndex <= normalizedRange.endIndex;
    candleIndex += 1
  ) {
    const candle = normalizedCandles[candleIndex];
    const relativeCandleIndex = candleIndex - normalizedRange.startIndex;

    for (let stage = 1; stage <= config.framesPerCandle; stage += 1) {
      const frameIndex = frames.length;
      const phase = stage / config.framesPerCandle;
      frames.push({
        frameIndex,
        candleIndex,
        relativeCandleIndex,
        phase,
        replayTimeMs: Math.round(
          interpolate(candle.openTimeMs, candle.closeTimeMs, phase),
        ),
        elapsedMs: frameIndex * frameDurationMs,
        durationMs: frameDurationMs,
        isLastFrame: frameIndex === frameCount - 1,
      });
    }
  }

  return {
    resolution: { ...VIDEO_EXPORT_RESOLUTION },
    config,
    range: { ...normalizedRange },
    frameDurationMs,
    totalDurationMs: frameCount * frameDurationMs,
    frames,
  };
}

/**
 * 一次完成配置规范化、交易窗口定位和帧计划生成。
 */
export function createVideoExportPlan(
  trade,
  candles,
  inputConfig = undefined,
) {
  const config = normalizeVideoExportConfig(inputConfig);
  const range = resolveVideoExportWindow(trade, candles, config);
  return buildVideoExportFramePlan(candles, range, config);
}

function resolveClosedTradeTimes(trade) {
  if (!isRecord(trade)) {
    throw new TypeError("交易记录必须是对象");
  }
  if (isRecord(trade.openPosition)) {
    throw new RangeError("交易尚未完全平仓，不能导出视频");
  }

  const quantity = positiveFiniteNumber(trade.quantity, "交易数量");
  const entryTimeMs = validTimeMs(trade.entryTime, "入场时间");
  let finalExitTimeMs;

  if (Array.isArray(trade.exits) && trade.exits.length > 0) {
    let exitedQuantity = 0;
    const exitTimes = [];

    for (const [index, exit] of trade.exits.entries()) {
      if (!isRecord(exit)) {
        throw new TypeError(`第 ${index + 1} 笔平仓记录必须是对象`);
      }
      exitedQuantity += positiveFiniteNumber(
        exit.quantity,
        `第 ${index + 1} 笔平仓数量`,
      );
      positiveFiniteNumber(exit.exitPrice, `第 ${index + 1} 笔平仓价格`);
      exitTimes.push(validTimeMs(exit.exitTime, `第 ${index + 1} 笔平仓时间`));
    }

    if (!quantitiesEqual(exitedQuantity, quantity)) {
      throw new RangeError("交易尚未完全平仓，不能导出视频");
    }
    finalExitTimeMs = Math.max(...exitTimes);
  } else {
    positiveFiniteNumber(trade.exitPrice, "平仓价格");
    finalExitTimeMs = validTimeMs(trade.exitTime, "平仓时间");
    const exitQuantity = trade.exitQuantity === undefined ||
      trade.exitQuantity === null ||
      trade.exitQuantity === ""
      ? quantity
      : positiveFiniteNumber(trade.exitQuantity, "平仓数量");

    if (!quantitiesEqual(exitQuantity, quantity)) {
      throw new RangeError("交易尚未完全平仓，不能导出视频");
    }
  }

  if (finalExitTimeMs < entryTimeMs) {
    throw new RangeError("最终平仓时间不能早于入场时间");
  }

  return { entryTimeMs, finalExitTimeMs };
}

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError("视频导出至少需要一根 K 线");
  }

  const normalized = candles.map((candle, index) => {
    if (!isRecord(candle)) {
      throw new TypeError(`第 ${index + 1} 根 K 线必须是对象`);
    }
    const timeSeconds = finiteNumber(candle.time, `第 ${index + 1} 根 K 线时间`);
    return {
      source: candle,
      openTimeMs: timeSeconds * 1000,
      explicitCloseTimeMs: optionalFiniteNumber(candle.closeTime),
    };
  });

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].openTimeMs <= normalized[index - 1].openTimeMs) {
      throw new RangeError("K 线必须严格按时间升序排列");
    }
  }

  return normalized.map((candle, index) => {
    const nextOpenTimeMs = normalized[index + 1]?.openTimeMs;
    let closeTimeMs = candle.explicitCloseTimeMs;

    if (closeTimeMs === null && Number.isFinite(nextOpenTimeMs)) {
      closeTimeMs = nextOpenTimeMs - 1;
    }
    if (closeTimeMs === null && index > 0) {
      const inferredInterval =
        candle.openTimeMs - normalized[index - 1].openTimeMs;
      closeTimeMs = candle.openTimeMs + inferredInterval - 1;
    }
    if (closeTimeMs === null) {
      throw new RangeError("最后一根 K 线缺少 closeTime，无法确定回放时间");
    }
    if (closeTimeMs < candle.openTimeMs) {
      throw new RangeError(`第 ${index + 1} 根 K 线的 closeTime 早于开盘时间`);
    }
    if (
      Number.isFinite(nextOpenTimeMs) &&
      closeTimeMs >= nextOpenTimeMs
    ) {
      throw new RangeError(`第 ${index + 1} 根 K 线与下一根 K 线时间重叠`);
    }

    return {
      source: candle.source,
      openTimeMs: candle.openTimeMs,
      closeTimeMs,
    };
  });
}

function locateContainingCandle(candles, targetTimeMs, errorMessage) {
  let low = 0;
  let high = candles.length - 1;
  let candidateIndex = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].openTimeMs <= targetTimeMs) {
      candidateIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (
    candidateIndex < 0 ||
    targetTimeMs > candles[candidateIndex].closeTimeMs
  ) {
    throw new RangeError(errorMessage);
  }
  return candidateIndex;
}

function validateRange(range, candleCount) {
  if (!isRecord(range)) {
    throw new TypeError("视频导出范围必须是对象");
  }
  const startIndex = safeInteger(range.startIndex, "视频开始 K 线索引");
  const endIndex = safeInteger(range.endIndex, "视频结束 K 线索引");

  if (startIndex < 0 || endIndex < startIndex || endIndex >= candleCount) {
    throw new RangeError("视频导出范围超出当前 K 线数据");
  }

  const expectedCandleCount = endIndex - startIndex + 1;
  if (
    range.candleCount !== undefined &&
    safeInteger(range.candleCount, "视频 K 线数量") !== expectedCandleCount
  ) {
    throw new RangeError("视频导出范围的 K 线数量不一致");
  }

  return {
    ...range,
    startIndex,
    endIndex,
    candleCount: expectedCandleCount,
  };
}

function readConfigValue(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? input[key]
    : undefined;
}

function normalizeNonNegativeInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = formNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${label}必须是大于或等于 0 的整数`);
  }
  return number;
}

function normalizeBoundedPositiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback;
  const number = formNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new RangeError(`${label}必须是 1 到 ${maximum} 的整数`);
  }
  return number;
}

function normalizePositiveNumber(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = formNumber(value, label);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${label}必须是大于 0 的有限数字`);
  }
  return number;
}

function formNumber(value, label) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value.trim());
  }
  throw new TypeError(`${label}必须是有效数字`);
}

function safeInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`${label}必须是安全整数`);
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

function optionalFiniteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError("K 线 closeTime 必须是有限数字");
  }
  return number;
}

function positiveFiniteNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return number;
}

function validTimeMs(value, label) {
  const timestamp = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label}必须是有效时间`);
  }
  return timestamp;
}

function quantitiesEqual(left, right) {
  return (
    Math.abs(left - right) <=
    Math.max(1, Math.abs(left), Math.abs(right)) * QUANTITY_EPSILON
  );
}

function interpolate(start, end, phase) {
  if (phase <= 0) return start;
  if (phase >= 1) return end;
  return start + (end - start) * phase;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
