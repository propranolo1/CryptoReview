import assert from "node:assert/strict";
import test from "node:test";

import {
  createTrainingContinuationRequest,
  createTrainingHistoryRequest,
  createRandomTrainingRequest,
  mergeTrainingHistoryPages,
  prepareTrainingContinuationCandles,
  prepareTrainingCandles,
} from "../lib/training-market.mjs";

test("训练行情固定请求 BTCUSDT U 本位永续，并用随机历史结束时间", () => {
  const request = createRandomTrainingRequest({
    now: Date.UTC(2026, 6, 20),
    random: 0.5,
    interval: "15m",
    limit: 320,
  });

  assert.equal(request.symbol, "BTCUSDT");
  assert.equal(request.market, "binance-futures");
  assert.equal(request.interval, "15m");
  assert.equal(request.limit, 320);
  assert.ok(request.endTime < Date.UTC(2026, 6, 20));
  assert.match(request.url, /^\/api\/market\/klines\?/);
  assert.match(request.url, /symbol=BTCUSDT/);
  assert.match(request.url, /market=binance-futures/);
});

test("训练片段保留上下文并只返回足够完成一局的数据", () => {
  const candles = Array.from({ length: 360 }, (_, index) => ({
    time: 1_700_000_000 + index * 900,
    open: 60_000 + index,
    high: 60_010 + index,
    low: 59_990 + index,
    close: 60_005 + index,
    volume: 100 + index,
    closeTime: (1_700_000_000 + (index + 1) * 900) * 1000 - 1,
  }));

  const prepared = prepareTrainingCandles(
    { source: "Binance Futures · USDⓈ-M 永续", symbol: "BTCUSDT", candles },
    { contextCandles: 80, trainingCandles: 160 },
  );

  assert.equal(prepared.candles.length, 240);
  assert.equal(prepared.initialCursor, 79);
  assert.equal(prepared.source, "Binance Futures · USDⓈ-M 永续");
  assert.equal(prepared.candles.at(-1).time, candles.at(-1).time);
});

test("15m 多周期训练分页保留 8640 根历史上下文和 160 根后续行情", () => {
  const request = createRandomTrainingRequest({
    now: Date.UTC(2026, 6, 20),
    random: 0.25,
    interval: "15m",
    limit: 1000,
    historyCandles: 8800,
  });
  const candles = Array.from({ length: 8800 }, (_, index) => ({
    time: 1_700_000_000 + index * 900,
    open: 60_000 + index,
    high: 60_010 + index,
    low: 59_990 + index,
    close: 60_005 + index,
    volume: 100 + index,
    closeTime: (1_700_000_000 + (index + 1) * 900) * 1000 - 1,
  }));
  const prepared = prepareTrainingCandles(
    { source: "Binance Futures · USDⓈ-M 永续", symbol: "BTCUSDT", candles },
    { contextCandles: 8640, trainingCandles: 160 },
  );

  assert.equal(request.limit, 1000);
  assert.equal(prepared.candles.length, 8800);
  assert.equal(prepared.initialCursor, 8639);
  assert.equal(prepared.candles[8640].time, candles[8640].time);
});

test("训练历史分页请求向更早时间推进并按时间合并去重", () => {
  const request = createTrainingHistoryRequest({
    interval: "15m",
    endTime: 1_700_000_000_000,
    limit: 40,
  });
  const candle = (time, close) => ({
    time,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100,
    closeTime: time * 1000 + 899_999,
  });
  const merged = mergeTrainingHistoryPages([
    {
      source: "Binance Futures · USDⓈ-M 永续",
      symbol: "BTCUSDT",
      candles: [candle(300, 3), candle(400, 4)],
    },
    {
      source: "Binance Futures · USDⓈ-M 永续",
      symbol: "BTCUSDT",
      candles: [candle(100, 1), candle(200, 2), candle(300, 3)],
    },
  ]);

  assert.equal(request.endTime, 1_700_000_000_000);
  assert.equal(request.limit, 40);
  assert.match(request.url, /endTime=1700000000000/);
  assert.deepEqual(merged.candles.map((item) => item.time), [100, 200, 300, 400]);
});

test("训练行情不足或币对不符时拒绝开始，避免伪造 BTC 数据", () => {
  assert.throws(
    () => prepareTrainingCandles({ symbol: "SOLUSDT", candles: [] }),
    /BTCUSDT/,
  );
  assert.throws(
    () => prepareTrainingCandles({ symbol: "BTCUSDT", candles: [{ time: 1 }] }),
    /不足/,
  );
});

test("持仓到达片段末尾时从最后一根之后继续请求真实 BTC K 线", () => {
  const request = createTrainingContinuationRequest({
    interval: "15m",
    startTime: 1_700_000_899_999,
    limit: 240,
  });

  assert.equal(request.symbol, "BTCUSDT");
  assert.equal(request.market, "binance-futures");
  assert.equal(request.interval, "15m");
  assert.equal(request.startTime, 1_700_000_899_999);
  assert.equal(request.limit, 240);
  assert.match(request.url, /startTime=1700000899999/);
  assert.doesNotMatch(request.url, /endTime=/);
});

test("续接训练行情只保留最后已显示 K 线之后的新数据", () => {
  const duplicate = {
    time: 1_700_000_000,
    open: 60_000,
    high: 60_100,
    low: 59_900,
    close: 60_050,
    volume: 100,
    closeTime: 1_700_000_899_999,
  };
  const next = {
    time: 1_700_000_900,
    open: 60_050,
    high: 60_200,
    low: 60_000,
    close: 60_150,
    volume: 120,
    closeTime: 1_700_001_799_999,
  };

  const prepared = prepareTrainingContinuationCandles(
    {
      source: "Binance Futures · USDⓈ-M 永续",
      symbol: "BTCUSDT",
      candles: [duplicate, next],
    },
    { afterCloseTime: duplicate.closeTime },
  );

  assert.equal(prepared.source, "Binance Futures · USDⓈ-M 永续");
  assert.deepEqual(prepared.candles, [next]);
  assert.throws(
    () => prepareTrainingContinuationCandles(
      { symbol: "BTCUSDT", candles: [duplicate] },
      { afterCloseTime: duplicate.closeTime },
    ),
    /没有返回新的 K 线/,
  );
});
