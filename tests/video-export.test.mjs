import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_EXPORT_DEFAULTS,
  VIDEO_EXPORT_RESOLUTION,
  buildVideoExportFramePlan,
  createVideoExportPlan,
  normalizeVideoExportConfig,
  resolveVideoExportWindow,
} from "../lib/video-export.mjs";

const CANDLE_INTERVAL_MS = 60_000;
const FIRST_OPEN_MS = Date.parse("2026-07-01T00:00:00.000Z");

function createCandles(count = 200) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = FIRST_OPEN_MS + index * CANDLE_INTERVAL_MS;
    return {
      time: openTime / 1000,
      closeTime: openTime + CANDLE_INTERVAL_MS - 1,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000 + index,
    };
  });
}

function isoAtCandle(index, offsetMs = 0) {
  return new Date(FIRST_OPEN_MS + index * CANDLE_INTERVAL_MS + offsetMs).toISOString();
}

function createClosedTrade(overrides = {}) {
  return {
    id: "trade-btc-1",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 2,
    entryPrice: 60_000,
    entryTime: isoAtCandle(20, 30_000),
    exits: [
      {
        quantity: 0.75,
        exitPrice: 61_000,
        exitTime: isoAtCandle(30, 20_000),
        fee: 1,
      },
      {
        quantity: 1.25,
        exitPrice: 62_000,
        exitTime: isoAtCandle(40, 10_000),
        fee: 1,
      },
    ],
    ...overrides,
  };
}

test("视频导出配置使用 10 根前置、100 根后置、1 倍速与每根 12 帧默认值", () => {
  assert.deepEqual(VIDEO_EXPORT_DEFAULTS, {
    preEntryCandles: 10,
    postExitCandles: 100,
    playbackSpeed: 1,
    framesPerCandle: 12,
  });
  assert.deepEqual(VIDEO_EXPORT_RESOLUTION, { width: 1920, height: 1080 });
  assert.deepEqual(normalizeVideoExportConfig(), VIDEO_EXPORT_DEFAULTS);
});

test("配置规范化接受表单字符串，但拒绝负数、小数、空值和无效播放速度", () => {
  assert.deepEqual(
    normalizeVideoExportConfig({
      preEntryCandles: "25",
      postExitCandles: "80",
      playbackSpeed: "2.5",
      framesPerCandle: "24",
    }),
    {
      preEntryCandles: 25,
      postExitCandles: 80,
      playbackSpeed: 2.5,
      framesPerCandle: 24,
    },
  );

  assert.throws(
    () => normalizeVideoExportConfig({ preEntryCandles: -1 }),
    /入场前 K 线数量/,
  );
  assert.throws(
    () => normalizeVideoExportConfig({ postExitCandles: 1.5 }),
    /平仓后 K 线数量/,
  );
  assert.throws(
    () => normalizeVideoExportConfig({ playbackSpeed: 0 }),
    /播放速度/,
  );
  assert.throws(
    () => normalizeVideoExportConfig({ framesPerCandle: "" }),
    /每根 K 线帧数/,
  );
});

test("导出窗口以入场 K 线和最终平仓 K 线定位，并保留完整前后数量", () => {
  const candles = createCandles();
  const range = resolveVideoExportWindow(createClosedTrade(), candles);

  assert.deepEqual(range, {
    entryIndex: 20,
    finalExitIndex: 40,
    startIndex: 10,
    endIndex: 140,
    candleCount: 131,
    entryTimeMs: FIRST_OPEN_MS + 20 * CANDLE_INTERVAL_MS + 30_000,
    finalExitTimeMs: FIRST_OPEN_MS + 40 * CANDLE_INTERVAL_MS + 10_000,
    preEntryCandles: 10,
    postExitCandles: 100,
  });
});

test("恰好落在新 K 线开盘时的成交归入新 K 线", () => {
  const trade = createClosedTrade({
    entryTime: isoAtCandle(20),
    exits: [{
      quantity: 2,
      exitPrice: 62_000,
      exitTime: isoAtCandle(40),
      fee: 1,
    }],
  });

  const range = resolveVideoExportWindow(trade, createCandles(), {
    preEntryCandles: 0,
    postExitCandles: 0,
  });

  assert.equal(range.entryIndex, 20);
  assert.equal(range.finalExitIndex, 40);
  assert.equal(range.startIndex, 20);
  assert.equal(range.endIndex, 40);
});

test("未完全平仓、仍带当前仓位或缺失有效成交时间的交易不能导出", () => {
  const candles = createCandles();

  assert.throws(
    () => resolveVideoExportWindow(
      createClosedTrade({
        exits: [{
          quantity: 1,
          exitPrice: 61_000,
          exitTime: isoAtCandle(30),
          fee: 1,
        }],
      }),
      candles,
    ),
    /尚未完全平仓/,
  );

  assert.throws(
    () => resolveVideoExportWindow(
      createClosedTrade({ openPosition: { quantity: 0.5 } }),
      candles,
    ),
    /尚未完全平仓/,
  );

  assert.throws(
    () => resolveVideoExportWindow(
      createClosedTrade({
        exits: [{
          quantity: 2,
          exitPrice: 62_000,
          exitTime: null,
          fee: 1,
        }],
      }),
      candles,
    ),
    /平仓时间/,
  );
});

test("旧版单次平仓记录可通过顶层平仓字段形成闭合交易", () => {
  const trade = createClosedTrade({
    exits: [],
    exitPrice: 62_000,
    exitTime: isoAtCandle(40, 10_000),
  });

  const range = resolveVideoExportWindow(trade, createCandles());
  assert.equal(range.finalExitIndex, 40);
});

test("行情覆盖不足、成交落在行情缺口或 K 线未按时间升序时明确拒绝导出", () => {
  const candles = createCandles();

  assert.throws(
    () => resolveVideoExportWindow(createClosedTrade(), candles.slice(15), {
      preEntryCandles: 10,
      postExitCandles: 20,
    }),
    /入场前 K 线不足/,
  );
  assert.throws(
    () => resolveVideoExportWindow(createClosedTrade(), candles.slice(0, 80)),
    /平仓后 K 线不足/,
  );

  const candlesWithGap = createCandles();
  candlesWithGap[40] = {
    ...candlesWithGap[40],
    time: (FIRST_OPEN_MS + 40 * CANDLE_INTERVAL_MS + 30_000) / 1000,
    closeTime: FIRST_OPEN_MS + 41 * CANDLE_INTERVAL_MS - 1,
  };
  assert.throws(
    () => resolveVideoExportWindow(createClosedTrade(), candlesWithGap),
    /最终平仓时间没有对应的 K 线/,
  );

  const unordered = createCandles();
  [unordered[10], unordered[11]] = [unordered[11], unordered[10]];
  assert.throws(
    () => resolveVideoExportWindow(createClosedTrade(), unordered),
    /严格按时间升序/,
  );
});

test("帧计划为每根 K 线生成固定内部阶段，播放速度只改变每帧持续时间", () => {
  const candles = createCandles();
  const range = resolveVideoExportWindow(createClosedTrade(), candles, {
    preEntryCandles: 1,
    postExitCandles: 2,
    playbackSpeed: 2,
  });
  const plan = buildVideoExportFramePlan(candles, range, {
    preEntryCandles: 1,
    postExitCandles: 2,
    playbackSpeed: 2,
  });

  assert.equal(plan.frames.length, range.candleCount * 12);
  assert.equal(plan.frameDurationMs, 50);
  assert.equal(plan.totalDurationMs, plan.frames.length * 50);
  assert.deepEqual(plan.resolution, { width: 1920, height: 1080 });

  assert.deepEqual(plan.frames[0], {
    frameIndex: 0,
    candleIndex: range.startIndex,
    relativeCandleIndex: 0,
    phase: 1 / 12,
    replayTimeMs:
      FIRST_OPEN_MS + range.startIndex * CANDLE_INTERVAL_MS +
      Math.round((CANDLE_INTERVAL_MS - 1) / 12),
    elapsedMs: 0,
    durationMs: 50,
    isLastFrame: false,
  });

  assert.equal(plan.frames[11].phase, 1);
  assert.equal(plan.frames[12].candleIndex, range.startIndex + 1);
  assert.equal(plan.frames[12].phase, 1 / 12);
  assert.equal(plan.frames.at(-1).phase, 1);
  assert.equal(plan.frames.at(-1).isLastFrame, true);
});

test("组合计划统一返回规范化配置、1080P 分辨率、窗口和可配置帧数", () => {
  const plan = createVideoExportPlan(
    createClosedTrade(),
    createCandles(),
    {
      preEntryCandles: "2",
      postExitCandles: "3",
      playbackSpeed: "0.5",
      framesPerCandle: "4",
    },
  );

  assert.deepEqual(plan.config, {
    preEntryCandles: 2,
    postExitCandles: 3,
    playbackSpeed: 0.5,
    framesPerCandle: 4,
  });
  assert.equal(plan.range.startIndex, 18);
  assert.equal(plan.range.endIndex, 43);
  assert.equal(plan.frames.length, plan.range.candleCount * 4);
  assert.deepEqual(
    plan.frames.slice(0, 4).map((frame) => frame.phase),
    [0.25, 0.5, 0.75, 1],
  );
  assert.equal(plan.frameDurationMs, 200);
});
