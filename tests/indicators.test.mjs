import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVolumeCandleColorPoint,
  buildVolumeCandleColorSeries,
  buildReplayEmaSeries,
  buildReplayOrderFlowSeries,
  buildReplayXinMentorshipSeries,
  calculateEmaSeries,
  calculateVolumeDelta,
  calculateXinMentorship,
  createXinMentorshipAccumulator,
} from "../lib/indicators.mjs";

function volumeCandles(volumes, downIndexes = []) {
  const down = new Set(downIndexes);
  return volumes.map((volume, index) => ({
    time: 1_700_000_000 + index * 300,
    open: 100,
    high: 102,
    low: 98,
    close: down.has(index) ? 99 : 101,
    volume,
  }));
}

test("量能染色默认使用 RVOL 20 和最高最低量回看 30", () => {
  const result = buildVolumeCandleColorSeries(volumeCandles(Array(30).fill(100)));

  assert.equal(result.config.rvolPeriod, 20);
  assert.equal(result.config.lookback, 30);
  assert.equal(result.config.highRvolMultiplier, 3);
  assert.equal(result.config.lowRvolMultiplier, 0.25);
  assert.equal(result.points.every((point) => point.tone === null), true);
});

test("RVOL 严格超过 3 倍时按涨跌染为绿红，0.25 倍时统一染黄", () => {
  const green = buildVolumeCandleColorSeries(
    volumeCandles([...Array(20).fill(100), 301]),
    { lookback: 50 },
  );
  const red = buildVolumeCandleColorSeries(
    volumeCandles([...Array(20).fill(100), 301], [20]),
    { lookback: 50 },
  );
  const boundary = buildVolumeCandleColorSeries(
    volumeCandles([...Array(20).fill(100), 300]),
    { lookback: 50 },
  );
  const yellow = buildVolumeCandleColorSeries(
    volumeCandles([...Array(20).fill(100), 25], [20]),
    { lookback: 50 },
  );

  assert.equal(green.points.at(-1).rvol, 3.01);
  assert.equal(green.points.at(-1).tone, "bullish");
  assert.equal(green.points.at(-1).trigger, "rvol-high");
  assert.equal(red.points.at(-1).tone, "bearish");
  assert.equal(boundary.points.at(-1).tone, null);
  assert.equal(yellow.points.at(-1).rvol, 0.25);
  assert.equal(yellow.points.at(-1).tone, "low");
  assert.equal(yellow.points.at(-1).trigger, "rvol-low");
});

test("回看窗口最高量按涨跌染为绿红，最低量统一染黄", () => {
  const middleVolumes = Array.from({ length: 29 }, (_, index) => 100 + index);
  const highestUp = buildVolumeCandleColorSeries(
    volumeCandles([...middleVolumes, 150]),
    { rvolPeriod: 50, lookback: 30 },
  );
  const highestDown = buildVolumeCandleColorSeries(
    volumeCandles([...middleVolumes, 150], [29]),
    { rvolPeriod: 50, lookback: 30 },
  );
  const lowest = buildVolumeCandleColorSeries(
    volumeCandles([...middleVolumes, 90], [29]),
    { rvolPeriod: 50, lookback: 30 },
  );

  assert.equal(highestUp.points.at(-1).tone, "bullish");
  assert.equal(highestUp.points.at(-1).trigger, "lookback-high");
  assert.equal(highestDown.points.at(-1).tone, "bearish");
  assert.equal(lowest.points.at(-1).tone, "low");
  assert.equal(lowest.points.at(-1).trigger, "lookback-low");
});

test("量能染色只使用当前及此前 K 线，并校验周期参数", () => {
  const visible = volumeCandles([...Array(20).fill(100), 301]);
  const before = buildVolumeCandleColorSeries(visible);
  const after = buildVolumeCandleColorSeries([
    ...visible,
    ...volumeCandles([1, 10_000]).map((candle, index) => ({
      ...candle,
      time: visible.at(-1).time + (index + 1) * 300,
    })),
  ]);

  assert.deepEqual(after.points.slice(0, visible.length), before.points);
  assert.throws(
    () => buildVolumeCandleColorSeries(visible, { rvolPeriod: 0 }),
    /RVOL 周期/,
  );
  assert.throws(
    () => buildVolumeCandleColorSeries(visible, { lookback: 1.5 }),
    /回看周期/,
  );
});

test("单根量能染色增量结果与全量计算一致", () => {
  const candles = volumeCandles([
    ...Array.from({ length: 35 }, (_, index) => 80 + index * 7),
    24,
    980,
  ], [36]);
  const full = buildVolumeCandleColorSeries(candles);

  candles.forEach((_, index) => {
    assert.deepEqual(
      buildVolumeCandleColorPoint(candles, index),
      full.points[index],
    );
  });
});

test("EMA 使用首个完整周期的 SMA 作为种子", () => {
  assert.deepEqual(calculateEmaSeries([10, 11, 12, 13, 14], 3), [
    null,
    null,
    11,
    12,
    13,
  ]);
});

test("EMA21 和 EMA200 在样本不足时不伪造指标值", () => {
  assert.deepEqual(calculateEmaSeries([10, 11], 21), [null, null]);
  assert.equal(calculateEmaSeries(Array.from({ length: 200 }, () => 5), 200).at(-1), 5);
});

test("回放 EMA 只使用当前时刻以前的收盘价和当前部分 K 线价格", () => {
  const candles = [
    { time: 100, close: 10 },
    { time: 200, close: 11 },
    { time: 300, close: 12 },
    { time: 400, close: 13 },
    { time: 500, close: 999 },
  ];

  assert.deepEqual(buildReplayEmaSeries(candles, 3, 12.5, 3), [
    { time: 300, value: 11 },
    { time: 400, value: 11.75 },
  ]);
});

test("EMA 拒绝无效周期和无效价格", () => {
  assert.throws(() => calculateEmaSeries([1, 2, 3], 0), /EMA 周期/);
  assert.throws(() => calculateEmaSeries([1, Number.NaN], 2), /EMA 价格/);
});

test("成交量 Delta 等于主动买量减主动卖量", () => {
  assert.equal(calculateVolumeDelta(100, 60), 20);
  assert.equal(calculateVolumeDelta(100, 40), -20);
  assert.equal(calculateVolumeDelta(100, 50), 0);
});

test("回放 Delta 与 CVD 不提前泄露尚未走完的当前 K 线", () => {
  const candles = [
    { time: 100, volume: 100, takerBuyVolume: 60 },
    { time: 200, volume: 100, takerBuyVolume: 40 },
    { time: 300, volume: 80, takerBuyVolume: 50 },
    { time: 400, volume: 1_000, takerBuyVolume: 1_000 },
  ];
  const forming = buildReplayOrderFlowSeries(candles, 2, 0.5);

  assert.equal(forming.available, true);
  assert.deepEqual(forming.delta, [
    { time: 100, value: 20 },
    { time: 200, value: -20 },
  ]);
  assert.deepEqual(forming.cvd, [
    { time: 100, value: 20 },
    { time: 200, value: 0 },
  ]);

  const completed = buildReplayOrderFlowSeries(candles, 2, 1);
  assert.deepEqual(completed.delta, [
    { time: 100, value: 20 },
    { time: 200, value: -20 },
    { time: 300, value: 20 },
  ]);
  assert.deepEqual(completed.cvd, [
    { time: 100, value: 20 },
    { time: 200, value: 0 },
    { time: 300, value: 20 },
  ]);
});

test("缺少主动买量时不伪造 Delta 与 CVD", () => {
  assert.deepEqual(
    buildReplayOrderFlowSeries([{ time: 100, volume: 100 }], 0, 1),
    { available: false, delta: [], cvd: [] },
  );
  assert.throws(() => calculateVolumeDelta(100, 101), /主动买量/);
});

function xinCandles(length = 260) {
  return Array.from({ length }, (_, index) => {
    const center = 100 + Math.sin(index / 7) * 18 + Math.sin(index / 19) * 7;
    const open = center + Math.sin(index / 3) * 2;
    const close = center + Math.cos(index / 4) * 2;
    return {
      time: 1_700_000_000 + index * 900,
      open,
      high: Math.max(open, close) + 3,
      low: Math.min(open, close) - 3,
      close,
      volume: 1_000 + (index % 17) * 80,
    };
  });
}

test("XIN Mentorship 按 Pine 默认参数生成 WT、MFI、动量与信号状态", () => {
  const result = calculateXinMentorship(xinCandles());

  assert.equal(result.points.length, 260);
  assert.equal(result.config.wtChannelLength, 9);
  assert.equal(result.config.wtAverageLength, 12);
  assert.equal(result.config.wtMaLength, 3);
  assert.equal(result.config.overbought1, 53);
  assert.equal(result.config.oversold1, -53);
  assert.equal(
    result.points.slice(80).some((point) => Number.isFinite(point.wt1)),
    true,
  );
  assert.equal(
    result.points.slice(80).some((point) => Number.isFinite(point.wt2)),
    true,
  );
  assert.equal(
    result.points.slice(80).some((point) => Number.isFinite(point.momentum)),
    true,
  );
  assert.equal(
    result.points.slice(80).some((point) => Number.isFinite(point.mfi)),
    true,
  );
  assert.ok([
    "extreme-overbought",
    "overbought",
    "extreme-oversold",
    "oversold",
    "bullish",
    "bearish",
  ].includes(result.status));
});

test("XIN 增量追加与替换最后一根保持全量算法一致", () => {
  const candles = xinCandles(320);
  const accumulator = createXinMentorshipAccumulator();
  candles.slice(0, -1).forEach((candle) => accumulator.append(candle));
  accumulator.append(candles.at(-1));
  assert.deepEqual(accumulator.snapshot(), calculateXinMentorship(candles));

  const replacement = {
    ...candles.at(-1),
    high: candles.at(-1).high + 4,
    close: candles.at(-1).close + 2,
    volume: candles.at(-1).volume * 1.6,
  };
  accumulator.replaceLast(replacement);
  assert.equal(accumulator.length, candles.length);
  assert.deepEqual(
    accumulator.snapshot(),
    calculateXinMentorship([...candles.slice(0, -1), replacement]),
  );
});

test("XIN Mentorship 回放只计算游标以前行情，当前柱使用部分 OHLC", () => {
  const candles = xinCandles();
  const cursor = 180;
  const partial = {
    ...candles[cursor],
    high: candles[cursor].open + 1,
    low: candles[cursor].open - 2,
    close: candles[cursor].open - 1,
  };
  const original = buildReplayXinMentorshipSeries(candles, cursor, partial);
  const changedFuture = candles.map((candle, index) =>
    index > cursor
      ? { ...candle, close: candle.close * 20, high: candle.high * 20 }
      : candle,
  );
  const replayed = buildReplayXinMentorshipSeries(
    changedFuture,
    cursor,
    partial,
  );

  assert.deepEqual(replayed, original);
  assert.equal(original.points.at(-1).time, candles[cursor].time);
  assert.equal(original.points.length, cursor + 1);
});
