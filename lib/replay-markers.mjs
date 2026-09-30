/** 同根同方向合并已发生成交数量；圆环分母由整笔复盘的最大持仓提供。 */
export function buildReplayTradeMarkers(candles, events, replayTimeMs, options = {}) {
  const groups = new Map();
  for (const event of events) {
    if (!Number.isFinite(event.timeMs) || event.timeMs > replayTimeMs || !candles.length) continue;
    let left = 0;
    let right = candles.length - 1;
    let index = -1;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      if (candles[middle].time * 1000 <= event.timeMs) {
        index = middle;
        left = middle + 1;
      } else right = middle - 1;
    }
    if (index < 0) continue;
    const candle = candles[index];
    const endTime = candle.closeTime ?? (candles[index + 1]?.time * 1000 - 1);
    if (Number.isFinite(endTime) && event.timeMs > endTime) continue;
    const key = `${candle.time}:${event.side}`;
    const group = groups.get(key) ?? { time: candle.time, index, side: event.side, count: 0, text: "", price: event.price, quantity: 0, ratio: null };
    group.count += 1;
    if (Number.isFinite(event.quantity) && event.quantity > 0) group.quantity += event.quantity;
    group.ratio = options.showRatio !== false && Number.isFinite(options.peakQuantity) && options.peakQuantity > 0
      ? group.quantity / options.peakQuantity
      : null;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.time - right.time || left.side.localeCompare(right.side));
}
