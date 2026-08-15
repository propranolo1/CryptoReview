function candleSignature(candle) {
  if (!candle) return "empty";
  return [
    Number(candle.time),
    Number(candle.open),
    Number(candle.high),
    Number(candle.low),
    Number(candle.close),
    Number(candle.volume),
  ].join(":");
}

export function createTrainingSeriesCursor(seriesKey, candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError("训练图表 K 线必须是数组");
  }
  return Object.freeze({
    seriesKey: String(seriesKey),
    length: candles.length,
    lastSignature: candleSignature(candles.at(-1)),
  });
}

/** 判断图表应整批初始化、追加、更新最后一根，还是完全跳过。 */
export function classifyTrainingSeriesUpdate(previous, seriesKey, candles) {
  const next = createTrainingSeriesCursor(seriesKey, candles);
  if (!previous || previous.seriesKey !== next.seriesKey || next.length === 0) {
    return { mode: "reset", cursor: next };
  }
  if (
    next.length === previous.length &&
    next.lastSignature === previous.lastSignature
  ) {
    return { mode: "none", cursor: next };
  }
  if (next.length === previous.length) {
    const lastTime = Number(candles.at(-1)?.time);
    const previousTime = Number(previous.lastSignature.split(":", 1)[0]);
    if (lastTime === previousTime) {
      return { mode: "update-last", cursor: next };
    }
  }
  if (
    next.length === previous.length + 1 &&
    candleSignature(candles[previous.length - 1]) === previous.lastSignature
  ) {
    return { mode: "append", cursor: next };
  }
  return { mode: "reset", cursor: next };
}
