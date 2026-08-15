import assert from "node:assert/strict";
import test from "node:test";

import {
  getTrainingDrawingBucketRange,
  getTrainingDrawingLogicalIndex,
  getTrainingDrawingTimeAtLogicalIndex,
  moveTrainingRectangle,
  resizeTrainingRectangle,
} from "../lib/training-drawings.mjs";

test("训练矩形时间按目标周期映射到 UTC K 线时间桶", () => {
  const startTime = Date.UTC(2026, 6, 17, 10, 17) / 1000;
  const endTime = Date.UTC(2026, 6, 17, 13, 42) / 1000;

  assert.deepEqual(
    getTrainingDrawingBucketRange({ startTime, endTime, timeframe: "15m" }),
    {
      startTime: Date.UTC(2026, 6, 17, 10, 15) / 1000,
      endTime: Date.UTC(2026, 6, 17, 13, 30) / 1000,
      intervalSeconds: 15 * 60,
    },
  );
  assert.deepEqual(
    getTrainingDrawingBucketRange({ startTime, endTime, timeframe: "4H" }),
    {
      startTime: Date.UTC(2026, 6, 17, 8) / 1000,
      endTime: Date.UTC(2026, 6, 17, 12) / 1000,
      intervalSeconds: 4 * 60 * 60,
    },
  );
  assert.deepEqual(
    getTrainingDrawingBucketRange({ startTime, endTime, timeframe: "1D" }),
    {
      startTime: Date.UTC(2026, 6, 17) / 1000,
      endTime: Date.UTC(2026, 6, 17) / 1000,
      intervalSeconds: 24 * 60 * 60,
    },
  );
});

test("训练矩形反向绘制时仍返回从早到晚的同步区间", () => {
  const earlier = Date.UTC(2026, 6, 17, 1, 10) / 1000;
  const later = Date.UTC(2026, 6, 17, 5, 50) / 1000;
  assert.deepEqual(
    getTrainingDrawingBucketRange({
      startTime: later,
      endTime: earlier,
      timeframe: "1H",
    }),
    {
      startTime: Date.UTC(2026, 6, 17, 1) / 1000,
      endTime: Date.UTC(2026, 6, 17, 5) / 1000,
      intervalSeconds: 60 * 60,
    },
  );
});

test("训练绘图周期与时间必须有效", () => {
  assert.throws(
    () => getTrainingDrawingBucketRange({
      startTime: Number.NaN,
      endTime: 1,
      timeframe: "15m",
    }),
    /绘图时间/,
  );
  assert.throws(
    () => getTrainingDrawingBucketRange({
      startTime: 1,
      endTime: 2,
      timeframe: "5m",
    }),
    /时间框架/,
  );
});

test("训练矩形可移动并保留宽度、高度和附加属性", () => {
  const rectangle = {
    id: "rect-1",
    kind: "rectangle",
    startTime: 100,
    endTime: 200,
    topPrice: 120,
    bottomPrice: 80,
    color: "#6b7280",
  };
  assert.deepEqual(
    moveTrainingRectangle(rectangle, { timeDelta: 25, priceDelta: -10 }),
    {
      ...rectangle,
      startTime: 125,
      endTime: 225,
      topPrice: 110,
      bottomPrice: 70,
    },
  );
});

test("训练矩形四个角点可调整且跨越边界时仍保持规范范围", () => {
  const rectangle = {
    id: "rect-2",
    kind: "rectangle",
    startTime: 100,
    endTime: 200,
    topPrice: 120,
    bottomPrice: 80,
    color: "#16a34a",
  };
  assert.deepEqual(
    resizeTrainingRectangle(rectangle, "topLeft", { time: 75, price: 140 }),
    {
      ...rectangle,
      startTime: 75,
      topPrice: 140,
    },
  );
  assert.deepEqual(
    resizeTrainingRectangle(rectangle, "bottomRight", { time: 50, price: 150 }),
    {
      ...rectangle,
      startTime: 50,
      endTime: 100,
      topPrice: 150,
      bottomPrice: 120,
    },
  );
});

test("训练矩形调整拒绝无效坐标和未知角点", () => {
  const rectangle = {
    startTime: 100,
    endTime: 200,
    topPrice: 120,
    bottomPrice: 80,
  };
  assert.throws(
    () => moveTrainingRectangle(rectangle, {
      timeDelta: Number.NaN,
      priceDelta: 1,
    }),
    /偏移量/,
  );
  assert.throws(
    () => resizeTrainingRectangle(rectangle, "middle", { time: 1, price: 1 }),
    /角点/,
  );
});

test("训练矩形可把图表右侧留白投影为尚未揭示的未来 K 线时间", () => {
  const candles = [
    { time: 1_000 },
    { time: 1_900 },
    { time: 2_800 },
  ];

  assert.equal(getTrainingDrawingTimeAtLogicalIndex({
    candles,
    logicalIndex: 5,
    timeframe: "15m",
  }), 5_500);
  assert.equal(getTrainingDrawingLogicalIndex({
    candles,
    time: 5_500,
    timeframe: "15m",
  }), 5);
});
