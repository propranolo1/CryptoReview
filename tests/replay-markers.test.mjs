import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayTradeMarkers } from "../lib/replay-markers.mjs";

const candles = [1000, 1300, 1600].map((time) => ({ time, closeTime: time * 1000 + 299999 }));
const event = (id, timeMs, side = "buy") => ({ id, timeMs, side, price: 100, quantity: 1 });

test("同一根 K 线同方向多笔成交合并数量，以最大持仓量显示比例", () => {
  const result = buildReplayTradeMarkers(candles, [event("a", 1010000), event("b", 1020000), event("c", 1100000)], 1200000, { peakQuantity: 6 });
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 3);
  assert.equal(result[0].text, "");
  assert.equal(result[0].quantity, 3);
  assert.equal(result[0].ratio, 0.5);
  assert.equal(result[0].time, 1000);
  assert.equal(result[0].side, "buy");
});

test("不同 K 线或不同买卖方向独立计数，单笔继续保留箭头", () => {
  const result = buildReplayTradeMarkers(candles, [event("a", 1010000), event("b", 1020000, "sell"), event("c", 1030000, "sell"), event("d", 1300000)], 1400000);
  assert.deepEqual(result.map(({ time, side, count, text }) => ({ time, side, count, text })), [
    { time: 1000, side: "buy", count: 1, text: "" },
    { time: 1000, side: "sell", count: 2, text: "" },
    { time: 1300, side: "buy", count: 1, text: "" },
  ]);
});

test("分批买卖都用整笔交易的持仓峰值，回退只减少已发生数量", () => {
  const events = [
    { ...event("a", 1010000), quantity: 2 },
    { ...event("b", 1200000), quantity: 6 },
    { ...event("c", 1300000, "sell"), quantity: 4 },
  ];
  const options = { peakQuantity: 8 };
  const early = buildReplayTradeMarkers(candles, events, 1100000, options);
  assert.equal(early[0].ratio, 0.25);
  const later = buildReplayTradeMarkers(candles, events, 1400000, options);
  assert.deepEqual(later.map((marker) => marker.ratio), [1, 0.5]);
  assert.equal(buildReplayTradeMarkers(candles, events, 1100000, options)[0].quantity, 2);
});

test("单笔建仓兼容原箭头，零峰值不生成无效比例，同根往返允许超过百分之百", () => {
  const events = [{ ...event("a", 1010000), quantity: 20 }];
  assert.equal(buildReplayTradeMarkers(candles, events, 1200000, { peakQuantity: 10, showRatio: false })[0].ratio, null);
  assert.equal(buildReplayTradeMarkers(candles, events, 1200000, { peakQuantity: 0 })[0].ratio, null);
  assert.equal(buildReplayTradeMarkers(candles, events, 1200000, { peakQuantity: 10 })[0].ratio, 2);
});

test("次数随回放时间增加，回退时减少，不提前暴露未来成交", () => {
  const events = [event("a", 1010000), event("b", 1200000), event("c", 1300000)];
  assert.equal(buildReplayTradeMarkers(candles, events, 1100000)[0].count, 1);
  assert.equal(buildReplayTradeMarkers(candles, events, 1250000)[0].count, 2);
  assert.deepEqual(buildReplayTradeMarkers(candles, events, 1000000), []);
});

test("可视历史之外的成交不吸附到首尾 K 线，乱序成交仍按时间绘制", () => {
  const result = buildReplayTradeMarkers(candles, [event("c", 1700000), event("a", 900000), event("d", 1900000), event("b", 1100000)], 2000000);
  assert.deepEqual(result.map((item) => item.time), [1000, 1600]);
  assert.deepEqual(buildReplayTradeMarkers([], [], 2000000), []);
});
