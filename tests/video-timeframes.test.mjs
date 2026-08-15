import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFixedReplayContext,
  buildReplayTimeframeCandles,
  createReplayTimeframeAggregator,
  VIDEO_REPLAY_CONTEXT_DEFAULTS,
} from "../lib/video-timeframes.mjs";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function candle(index, overrides = {}) {
  const startMs = Date.UTC(2026, 0, 1, 0, 0) + index * FIVE_MINUTES_MS;
  const open = 100 + index;
  return {
    time: startMs / 1000,
    open,
    high: open + 3,
    low: open - 2,
    close: open + 1,
    volume: 10 + index,
    takerBuyVolume: 4 + index,
    closeTime: startMs + FIVE_MINUTES_MS - 1,
    ...overrides,
  };
}

test("高周期聚合只使用已完成的 5m K 线与当前部分 K 线", () => {
  const candles = Array.from({ length: 15 }, (_, index) => candle(index));
  candles[7] = candle(7, {
    high: 9_999,
    close: 9_999,
    volume: 9_999,
  });

  const replayTimeMs = candles[6].time * 1000 + 2 * 60 * 1000;
  const currentCandle = {
    ...candles[6],
    high: 108,
    low: 103,
    close: 107,
    volume: 3,
    takerBuyVolume: 1,
    closeTime: replayTimeMs,
  };

  const result = buildReplayTimeframeCandles(candles, {
    cursor: 6,
    replayTimeMs,
    currentCandle,
  });

  assert.deepEqual(Object.keys(result), ["15m", "1H", "4H", "1D"]);
  assert.equal(result["15m"].length, 3);
  assert.equal(result["15m"].at(-1).open, candles[6].open);
  assert.equal(result["15m"].at(-1).close, currentCandle.close);
  assert.equal(result["15m"].at(-1).volume, currentCandle.volume);
  assert.equal(result["1H"].length, 1);
  assert.deepEqual(result["1H"][0], {
    time: candles[0].time,
    open: candles[0].open,
    high: 108,
    low: candles[0].low,
    close: 107,
    volume: candles.slice(0, 6).reduce((sum, item) => sum + item.volume, 0) + 3,
    takerBuyVolume:
      candles.slice(0, 6).reduce((sum, item) => sum + item.takerBuyVolume, 0) + 1,
    closeTime: replayTimeMs,
  });
  assert.equal(
    result["1H"].some((item) => item.high === 9_999),
    false,
    "播放游标之后的极值不能进入高周期",
  );
});

test("没有传入当前部分 K 线时只暴露当前 5m 的开盘状态", () => {
  const candles = [
    candle(0),
    candle(1, {
      high: 5_000,
      low: 1,
      close: 4_000,
      volume: 8_000,
      takerBuyVolume: 7_000,
    }),
  ];
  const replayTimeMs = candles[1].time * 1000 + 30_000;

  const result = buildReplayTimeframeCandles(candles, {
    cursor: 1,
    replayTimeMs,
  });

  assert.equal(result["1H"][0].high, candles[0].high);
  assert.equal(result["1H"][0].close, candles[1].open);
  assert.equal(result["1H"][0].volume, candles[0].volume);
  assert.equal(result["1H"][0].takerBuyVolume, candles[0].takerBuyVolume);
  assert.equal(result["1H"][0].closeTime, replayTimeMs);
});

test("1H、4H、1D 都按 UTC 自然时间桶聚合", () => {
  const startMs = Date.UTC(2026, 0, 1, 3, 55);
  const candles = Array.from({ length: 244 }, (_, index) =>
    candle(index, {
      time: (startMs + index * FIVE_MINUTES_MS) / 1000,
      closeTime: startMs + (index + 1) * FIVE_MINUTES_MS - 1,
    }),
  );
  const cursor = candles.length - 1;
  const replayTimeMs = candles[cursor].closeTime;

  const result = buildReplayTimeframeCandles(candles, {
    cursor,
    replayTimeMs,
    currentCandle: candles[cursor],
  });

  assert.deepEqual(
    result["1H"].slice(0, 3).map((item) => item.time),
    [
      Date.UTC(2026, 0, 1, 3, 0) / 1000,
      Date.UTC(2026, 0, 1, 4, 0) / 1000,
      Date.UTC(2026, 0, 1, 5, 0) / 1000,
    ],
  );
  assert.deepEqual(
    result["4H"].slice(0, 2).map((item) => item.time),
    [
      Date.UTC(2026, 0, 1, 0, 0) / 1000,
      Date.UTC(2026, 0, 1, 4, 0) / 1000,
    ],
  );
  assert.deepEqual(
    result["1D"].map((item) => item.time),
    [
      Date.UTC(2026, 0, 1, 0, 0) / 1000,
      Date.UTC(2026, 0, 2, 0, 0) / 1000,
    ],
  );
});

test("15m 训练行情正确聚合为 4H 和 1D，且不读取游标后的未来数据", () => {
  const startMs = Date.UTC(2026, 0, 1, 0, 0);
  const candles = Array.from({ length: 98 }, (_, index) => {
    const open = 60_000 + index;
    return {
      time: (startMs + index * FIFTEEN_MINUTES_MS) / 1000,
      open,
      high: open + 10,
      low: open - 10,
      close: open + 5,
      volume: 100 + index,
      closeTime: startMs + (index + 1) * FIFTEEN_MINUTES_MS - 1,
    };
  });
  candles[96] = {
    ...candles[96],
    high: 999_999,
    close: 999_999,
    volume: 999_999,
  };

  const cursor = 95;
  const result = buildReplayTimeframeCandles(candles, {
    cursor,
    replayTimeMs: candles[cursor].closeTime,
    currentCandle: candles[cursor],
  });

  assert.equal(result["4H"].length, 6);
  assert.equal(result["1D"].length, 1);
  assert.equal(result["4H"][0].open, candles[0].open);
  assert.equal(result["4H"][0].close, candles[15].close);
  assert.equal(result["1D"][0].close, candles[95].close);
  assert.equal(result["1D"][0].high, candles[95].high);
  assert.equal(
    result["1D"].some((item) => item.high === 999_999),
    false,
    "尚未揭示的 15m K 线不能进入 4H 或 1D 小图",
  );
});

test("固定上下文在视频第一帧就携带播放起点之前的 K 线", () => {
  const candles = Array.from({ length: 400 }, (_, index) => candle(index));

  const context = buildFixedReplayContext(candles, {
    cursor: 280,
    currentCandle: candle(280, { close: 381.5 }),
  });

  assert.equal(VIDEO_REPLAY_CONTEXT_DEFAULTS.visibleCandles, 80);
  assert.equal(context.slotCount, 80);
  assert.equal(context.candles.length, 80);
  assert.equal(context.startIndex, 201);
  assert.equal(context.endIndex, 280);
  assert.equal(context.currentSlot, 79);
  assert.equal(context.candles.at(-1).close, 381.5);
});

test("播放推进后可视槽位数量不变，蜡烛宽度不会随累计数量改变", () => {
  const candles = Array.from({ length: 400 }, (_, index) => candle(index));
  const first = buildFixedReplayContext(candles, { cursor: 280 });
  const next = buildFixedReplayContext(candles, { cursor: 281 });

  assert.equal(first.slotCount, next.slotCount);
  assert.equal(first.candles.length, next.candles.length);
  assert.equal(first.currentSlot, next.currentSlot);
  assert.equal(first.startIndex + 1, next.startIndex);
});

test("历史不足时仍保留固定绘图槽位并将已有 K 线右对齐", () => {
  const candles = [candle(0), candle(1), candle(2)];
  const context = buildFixedReplayContext(candles, {
    cursor: 2,
    visibleCandles: 80,
  });

  assert.equal(context.candles.length, 3);
  assert.equal(context.slotCount, 80);
  assert.equal(context.paddingSlots, 77);
  assert.equal(context.currentSlot, 79);
});

test("聚合不会修改输入 K 线或调用方传入的当前部分 K 线", () => {
  const candles = Array.from({ length: 14 }, (_, index) => candle(index));
  const currentCandle = {
    ...candles[6],
    high: 108,
    low: 103,
    close: 107,
    volume: 3,
    takerBuyVolume: 1,
  };
  const beforeCandles = structuredClone(candles);
  const beforeCurrent = structuredClone(currentCandle);

  buildReplayTimeframeCandles(candles, {
    cursor: 6,
    replayTimeMs: candles[6].time * 1000 + 60_000,
    currentCandle,
  });

  assert.deepEqual(candles, beforeCandles);
  assert.deepEqual(currentCandle, beforeCurrent);
});

test("缓存聚合器持有不可变快照，外部修改不会污染后续视频帧", () => {
  const candles = Array.from({ length: 24 }, (_, index) => candle(index));
  const aggregator = createReplayTimeframeAggregator(candles, {
    maxCandlesPerTimeframe: 4,
  });
  const replayTimeMs = candles[13].time * 1000 + 60_000;
  const partial = {
    ...candles[13],
    high: 116,
    low: 111,
    close: 115,
    volume: 2,
    takerBuyVolume: 1,
  };
  const beforeMutation = aggregator.build({
    cursor: 13,
    replayTimeMs,
    currentCandle: partial,
  });

  candles[0].high = 99_999;
  candles[12].close = 88_888;
  partial.close = 77_777;
  const afterMutation = aggregator.build({
    cursor: 13,
    replayTimeMs,
    currentCandle: {
      ...candle(13),
      high: 116,
      low: 111,
      close: 115,
      volume: 2,
      takerBuyVolume: 1,
    },
  });

  assert.deepEqual(afterMutation, beforeMutation);
  assert.equal(Object.isFrozen(afterMutation), true);
  assert.equal(Object.isFrozen(afterMutation["1H"]), true);
  assert.equal(Object.isFrozen(afterMutation["1H"][0]), true);
  assert.throws(() => {
    afterMutation["1H"].push(candle(100));
  }, TypeError);
});

test("UTC 零点前后的 5m K 线严格分入不同 1D 桶", () => {
  const beforeMidnight = candle(0, {
    time: Date.UTC(2026, 6, 28, 23, 55) / 1000,
    closeTime: Date.UTC(2026, 6, 28, 23, 59, 59, 999),
  });
  const afterMidnight = candle(1, {
    time: Date.UTC(2026, 6, 29, 0, 0) / 1000,
    closeTime: Date.UTC(2026, 6, 29, 0, 4, 59, 999),
  });

  const result = buildReplayTimeframeCandles(
    [beforeMidnight, afterMidnight],
    {
      cursor: 1,
      replayTimeMs: afterMidnight.closeTime,
      currentCandle: afterMidnight,
    },
  );

  assert.deepEqual(
    result["1D"].map((item) => item.time),
    [
      Date.UTC(2026, 6, 28, 0, 0) / 1000,
      Date.UTC(2026, 6, 29, 0, 0) / 1000,
    ],
  );
});

test("缺少 closeTime 时按下一根开盘或 5m 周期安全推导", () => {
  const candles = [candle(0), candle(1), candle(2)].map((item) => {
    const copy = { ...item };
    delete copy.closeTime;
    return copy;
  });
  const replayTimeMs = candles[2].time * 1000 + FIVE_MINUTES_MS - 1;

  const result = buildReplayTimeframeCandles(candles, {
    cursor: 2,
    replayTimeMs,
    currentCandle: candles[2],
  });
  const context = buildFixedReplayContext(candles, { cursor: 2 });

  assert.equal(result["1H"][0].closeTime, replayTimeMs);
  assert.equal(
    context.candles[0].closeTime,
    candles[1].time * 1000 - 1,
  );
  assert.equal(context.candles.at(-1).closeTime, replayTimeMs);
});
