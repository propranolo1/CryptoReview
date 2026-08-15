import assert from "node:assert/strict";
import test from "node:test";

import { fetchVideoExportCandles } from "../lib/video-market.mjs";

function candle(index) {
  const openTime = 1_800_000_000_000 + index * 60_000;
  return {
    time: openTime / 1000,
    closeTime: openTime + 59_999,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
    takerBuyVolume: 500 + index,
  };
}

test("视频行情超过单页上限时连续分页并去除边界重复 K 线", async () => {
  const all = Array.from({ length: 1_205 }, (_, index) => candle(index));
  const calls = [];
  const fetchImpl = async (url) => {
    const request = new URL(url, "http://localhost");
    const startTime = Number(request.searchParams.get("startTime"));
    calls.push(startTime);
    const pageStart = Math.max(
      0,
      all.findIndex((item) => item.closeTime >= startTime),
    );
    const page = all.slice(pageStart, pageStart + 1_000);
    if (calls.length === 2) page.unshift(all[999]);
    return {
      ok: true,
      async json() {
        return {
          source: "Binance Futures · USDⓈ-M 永续",
          symbol: "BTCUSDT",
          candles: page,
        };
      },
    };
  };

  const result = await fetchVideoExportCandles({
    fetchImpl,
    symbol: "BTCUSDT",
    interval: "1m",
    market: "binance-futures",
    startTime: all[0].time * 1000,
    endTime: all.at(-1).closeTime,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.candles.length, 1_205);
  assert.equal(result.candles[0].time, all[0].time);
  assert.equal(result.candles.at(-1).time, all.at(-1).time);
  assert.equal(result.source, "Binance Futures · USDⓈ-M 永续");
});

test("视频行情请求固定使用现有本地代理和用户所选市场参数", async () => {
  let requestedUrl = "";
  const first = candle(0);
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      async json() {
        return { source: "Binance Spot", symbol: "ETHUSDT", candles: [first] };
      },
    };
  };

  await fetchVideoExportCandles({
    fetchImpl,
    symbol: "eth/usdt",
    interval: "15m",
    market: "binance",
    startTime: first.time * 1000,
    endTime: first.closeTime,
  });

  const request = new URL(requestedUrl, "http://localhost");
  assert.equal(request.pathname, "/api/market/klines");
  assert.equal(request.searchParams.get("symbol"), "ETHUSDT");
  assert.equal(request.searchParams.get("interval"), "15m");
  assert.equal(request.searchParams.get("market"), "binance");
  assert.equal(request.searchParams.get("limit"), "1000");
});

test("上游错误、无进展分页和无效 K 线不会生成伪造视频行情", async () => {
  await assert.rejects(
    () => fetchVideoExportCandles({
      fetchImpl: async () => ({
        ok: false,
        async json() { return { message: "Binance 暂时不可用" }; },
      }),
      symbol: "BTCUSDT",
      interval: "5m",
      market: "binance-futures",
      startTime: 1_800_000_000_000,
      endTime: 1_800_001_000_000,
    }),
    /Binance 暂时不可用/,
  );

  const repeated = candle(0);
  await assert.rejects(
    () => fetchVideoExportCandles({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { source: "Binance Futures", symbol: "BTCUSDT", candles: [repeated] };
        },
      }),
      symbol: "BTCUSDT",
      interval: "5m",
      market: "binance-futures",
      startTime: repeated.time * 1000,
      endTime: repeated.closeTime + 60_000,
    }),
    /没有继续向后推进/,
  );

  await assert.rejects(
    () => fetchVideoExportCandles({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            source: "Binance Futures",
            symbol: "BTCUSDT",
            candles: [{ ...repeated, high: repeated.low - 1 }],
          };
        },
      }),
      symbol: "BTCUSDT",
      interval: "5m",
      market: "binance-futures",
      startTime: repeated.time * 1000,
      endTime: repeated.closeTime,
    }),
    /价格无效/,
  );
});
