/** 同一根 K 线、同一买卖方向合并显示；计数只包含当前已发生的成交。 */
export function buildReplayTradeMarkers(candles, events, replayTimeMs) {
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
    const group = groups.get(key) ?? { time: candle.time, index, side: event.side, count: 0, text: "", price: event.price };
    group.count += 1;
    group.text = group.count > 1 ? `${group.count}x` : "";
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.time - right.time || left.side.localeCompare(right.side));
}
