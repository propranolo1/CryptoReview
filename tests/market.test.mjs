import assert from "node:assert/strict";
import test from "node:test";

import {
  createBinanceFuturesOpenInterestUrl,
  createBinanceFuturesKlineUrl,
  parseBinanceOpenInterestHistory,
  parseBinanceKlines,
} from "../lib/market.mjs";

test("永续合约行情请求使用 Binance USDⓈ-M Futures 官方 K 线端点", () => {
  const url = new URL(createBinanceFuturesKlineUrl({
    symbol: "HYPEUSDT",
    interval: "5m",
    startTime: 1784187197000,
    endTime: 1784189057000,
    limit: 1000,
  }));

  assert.equal(url.origin, "https://fapi.binance.com");
  assert.equal(url.pathname, "/fapi/v1/klines");
  assert.equal(url.searchParams.get("symbol"), "HYPEUSDT");
  assert.equal(url.searchParams.get("interval"), "5m");
  assert.equal(url.searchParams.get("startTime"), "1784187197000");
  assert.equal(url.searchParams.get("endTime"), "1784189057000");
  assert.equal(url.searchParams.get("limit"), "1000");
});

test("Binance Futures K 线转换为图表统一结构", () => {
  const candles = parseBinanceKlines([
    [
      1784187000000,
      "66.571",
      "66.589",
      "66.373",
      "66.441",
      "15251.51",
      1784187299999,
    ],
    [
      1784187300000,
      "66.44",
      "66.473",
      "66.343",
      "66.381",
      "9732.32",
      1784187599999,
    ],
  ]);

  assert.deepEqual(candles, [
    {
      time: 1784187000,
      open: 66.571,
      high: 66.589,
      low: 66.373,
      close: 66.441,
      volume: 15251.51,
      closeTime: 1784187299999,
    },
    {
      time: 1784187300,
      open: 66.44,
      high: 66.473,
      low: 66.343,
      close: 66.381,
      volume: 9732.32,
      closeTime: 1784187599999,
    },
  ]);
});

test("Binance Futures K 线保留主动买入量供 Delta 与 CVD 计算", () => {
  const [candle] = parseBinanceKlines([[
    1784187000000,
    "66.571",
    "66.589",
    "66.373",
    "66.441",
    "100",
    1784187299999,
    "6644.1",
    308,
    "60",
    "3986.46",
    "0",
  ]]);

  assert.equal(candle.volume, 100);
  assert.equal(candle.takerBuyVolume, 60);
});

test("Binance K 线拒绝主动买量超过总成交量的数据", () => {
  assert.throws(
    () => parseBinanceKlines([[
      1784187000000, "66", "67", "65", "66", "100", 1784187299999,
      "6600", 100, "101", "6666", "0",
    ]]),
    /主动买量无效/,
  );
});

test("Binance K 线拒绝价格区间无效或时间倒序的数据", () => {
  assert.throws(
    () => parseBinanceKlines([[1000, "66", "65", "64", "66", "1", 1999]]),
    /价格无效/,
  );
  assert.throws(
    () => parseBinanceKlines([
      [2000, "66", "67", "65", "66", "1", 2999],
      [1000, "66", "67", "65", "66", "1", 1999],
    ]),
    /严格递增/,
  );
});

test("历史 OI 请求使用 Binance USDⓈ-M Futures 公开统计端点", () => {
  const url = new URL(createBinanceFuturesOpenInterestUrl({
    symbol: "BTCUSDT",
    period: "5m",
    startTime: 1784187197000,
    endTime: 1784190797000,
    limit: 500,
  }));

  assert.equal(url.origin, "https://fapi.binance.com");
  assert.equal(url.pathname, "/futures/data/openInterestHist");
  assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(url.searchParams.get("period"), "5m");
  assert.equal(url.searchParams.get("startTime"), "1784187197000");
  assert.equal(url.searchParams.get("endTime"), "1784190797000");
  assert.equal(url.searchParams.get("limit"), "500");
});

test("Binance Futures 历史 OI 转换为图表统一结构", () => {
  const points = parseBinanceOpenInterestHistory([
    {
      symbol: "BTCUSDT",
      sumOpenInterest: "80642.701",
      sumOpenInterestValue: "5391037901.42",
      timestamp: 1784187000000,
    },
    {
      symbol: "BTCUSDT",
      sumOpenInterest: "80711.125",
      sumOpenInterestValue: "5400123456.78",
      timestamp: 1784187300000,
    },
  ]);

  assert.deepEqual(points, [
    {
      time: 1784187000,
      openInterest: 80642.701,
      openInterestValue: 5391037901.42,
    },
    {
      time: 1784187300,
      openInterest: 80711.125,
      openInterestValue: 5400123456.78,
    },
  ]);
});

test("Binance Futures 历史 OI 拒绝负数、重复时间或无效字段", () => {
  assert.throws(
    () => parseBinanceOpenInterestHistory([{
      sumOpenInterest: "-1",
      sumOpenInterestValue: "10",
      timestamp: 1784187000000,
    }]),
    /OI 数据无效/,
  );
  assert.throws(
    () => parseBinanceOpenInterestHistory([
      { sumOpenInterest: "1", sumOpenInterestValue: "10", timestamp: 1784187000000 },
      { sumOpenInterest: "2", sumOpenInterestValue: "20", timestamp: 1784187000000 },
    ]),
    /时间不是严格递增/,
  );
  assert.throws(
    () => parseBinanceOpenInterestHistory([{
      sumOpenInterest: "not-a-number",
      sumOpenInterestValue: "10",
      timestamp: 1784187000000,
    }]),
    /OI 数据无效/,
  );
});
