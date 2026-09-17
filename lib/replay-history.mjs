import { isBinanceSymbol, normalizeBinanceSymbol } from "./exchange-sync.mjs";

/** 每个交易/周期使用独立加载器；仅限制单页数量，不限制可回看的历史总量。 */
export function createReplayHistoryLoader({ symbol, interval, market, fetchImpl }) {
  const normalizedSymbol = normalizeBinanceSymbol(symbol);
  const controller = new AbortController();
  let loading = false;
  let exhausted = false;
  return {
    cancel() { controller.abort(); },
    async load(candles, visibleBars = 320) {
      if (loading || exhausted || controller.signal.aborted || !candles.length) return null;
      loading = true;
      try {
        if (!isBinanceSymbol(normalizedSymbol)) throw new TypeError("历史行情交易对无效");
        const firstTime = candles[0].time;
        const limit = Math.min(1000, Math.max(320, Math.ceil(visibleBars)));
        const query = new URLSearchParams({
          symbol: normalizedSymbol,
          interval,
          market,
          endTime: String(firstTime * 1000 - 1),
          limit: String(limit),
        });
        const response = await fetchImpl(`/api/market/klines?${query}`, { signal: controller.signal });
        const payload = await response.json();
        if (controller.signal.aborted) return null;
        if (!response.ok) throw new Error(payload?.message || "更早的历史行情加载失败");
        if (payload?.symbol !== normalizedSymbol || payload.interval !== interval || !Array.isArray(payload.candles)) {
          throw new TypeError("历史行情响应与当前交易或周期不一致");
        }
        const olderByTime = new Map();
        for (const candle of payload.candles) {
          if (!candle || ![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
            candle.time <= 0 || candle.volume < 0 || candle.low > Math.min(candle.open, candle.close) ||
            candle.high < Math.max(candle.open, candle.close) ||
            (candle.closeTime !== undefined && (!Number.isFinite(candle.closeTime) || candle.closeTime < candle.time * 1000)) ||
            (candle.takerBuyVolume !== undefined && (!Number.isFinite(candle.takerBuyVolume) || candle.takerBuyVolume < 0 || candle.takerBuyVolume > candle.volume))) {
            throw new TypeError("历史 K 线数据无效");
          }
          if (candle.time < firstTime) olderByTime.set(candle.time, candle);
        }
        const older = [...olderByTime.values()].sort((left, right) => left.time - right.time);
        if (payload.candles.length && !older.length) throw new Error("行情接口没有返回更早的 K 线，请稍后重试");
        exhausted = payload.candles.length === 0;
        return { candles: [...older, ...candles], addedCount: older.length, exhausted };
      } finally {
        loading = false;
      }
    },
  };
}

/** 前插时平移逻辑坐标，保持用户正在查看的时间与缩放宽度。 */
export function shiftReplayHistoryRange(range, addedCount) {
  return range ? { from: range.from + addedCount, to: range.to + addedCount } : null;
}
