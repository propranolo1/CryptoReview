const BINANCE_FUTURES_KLINE_ENDPOINT = "https://fapi.binance.com/fapi/v1/klines";
const BINANCE_FUTURES_OPEN_INTEREST_ENDPOINT = "https://fapi.binance.com/futures/data/openInterestHist";

/** 创建 Binance USDⓈ-M Futures 永续 K 线请求地址。 */
export function createBinanceFuturesKlineUrl({
  symbol,
  interval,
  startTime,
  endTime,
  limit,
}) {
  const endpoint = new URL(BINANCE_FUTURES_KLINE_ENDPOINT);
  endpoint.searchParams.set("symbol", String(symbol));
  endpoint.searchParams.set("interval", String(interval));
  endpoint.searchParams.set("limit", String(limit));
  if (startTime) endpoint.searchParams.set("startTime", String(startTime));
  if (endTime) endpoint.searchParams.set("endTime", String(endTime));
  return endpoint.toString();
}

/** 创建 Binance USDⓈ-M Futures 历史持仓量请求地址。 */
export function createBinanceFuturesOpenInterestUrl({
  symbol,
  period,
  startTime,
  endTime,
  limit,
}) {
  const endpoint = new URL(BINANCE_FUTURES_OPEN_INTEREST_ENDPOINT);
  endpoint.searchParams.set("symbol", String(symbol));
  endpoint.searchParams.set("period", String(period));
  endpoint.searchParams.set("limit", String(limit));
  if (startTime) endpoint.searchParams.set("startTime", String(startTime));
  if (endTime) endpoint.searchParams.set("endTime", String(endTime));
  return endpoint.toString();
}

/** 将 Binance Spot / Futures K 线数组转换为项目统一 OHLCV 结构。 */
export function parseBinanceKlines(payload) {
  if (!Array.isArray(payload)) {
    throw new TypeError("Binance K 线响应格式无效");
  }

  const candles = payload.map((item) => {
    if (!Array.isArray(item) || item.length < 7) {
      throw new TypeError("Binance K 线字段不完整");
    }
    const candle = {
      time: Math.floor(Number(item[0]) / 1000),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5]),
      closeTime: Number(item[6]),
    };
    if (item.length >= 10) {
      const takerBuyVolume = Number(item[9]);
      if (
        !Number.isFinite(takerBuyVolume) ||
        takerBuyVolume < 0 ||
        takerBuyVolume > candle.volume
      ) {
        throw new TypeError("Binance K 线主动买量无效");
      }
      candle.takerBuyVolume = takerBuyVolume;
    }
    if (
      !Object.values(candle).every(Number.isFinite) ||
      candle.time <= 0 ||
      candle.closeTime <= 0 ||
      candle.volume < 0 ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high < Math.max(candle.open, candle.close)
    ) {
      throw new TypeError("Binance K 线价格无效");
    }
    return candle;
  });

  if (candles.some((candle, index) => index > 0 && candle.time <= candles[index - 1].time)) {
    throw new TypeError("Binance K 线时间不是严格递增");
  }
  return candles;
}

/** 将 Binance Futures 历史 OI 响应转换为图表统一结构。 */
export function parseBinanceOpenInterestHistory(payload) {
  if (!Array.isArray(payload)) {
    throw new TypeError("Binance Futures OI 响应格式无效");
  }

  const points = payload.map((item) => {
    if (!item || typeof item !== "object") {
      throw new TypeError("Binance Futures OI 字段不完整");
    }
    const point = {
      time: Math.floor(Number(item.timestamp) / 1000),
      openInterest: Number(item.sumOpenInterest),
      openInterestValue: Number(item.sumOpenInterestValue),
    };
    if (
      !Object.values(point).every(Number.isFinite) ||
      point.time <= 0 ||
      point.openInterest < 0 ||
      point.openInterestValue < 0
    ) {
      throw new TypeError("Binance Futures OI 数据无效");
    }
    return point;
  });

  if (points.some((point, index) => index > 0 && point.time <= points[index - 1].time)) {
    throw new TypeError("Binance Futures OI 时间不是严格递增");
  }
  return points;
}
