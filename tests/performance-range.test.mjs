import assert from "node:assert/strict";
import test from "node:test";
import * as performance from "../lib/performance.mjs";

const now = Date.parse("2026-10-14T04:00:00Z");
const dayMs = 24 * 60 * 60 * 1000;

function trade(id, closeTime, overrides = {}) {
  return {
    id, side: "long", quantity: 1, entryPrice: 100,
    entryTime: "2026-01-01T00:00:00Z", fee: 1,
    exits: [{ quantity: 1, exitPrice: 112, fee: 1, exitTime: closeTime }],
    ...overrides,
  };
}

test("默认所有持仓保留历史与未平仓记录，同一 id 仍以最后一份为准", () => {
  const latest = trade("duplicate", "2026-10-13T00:00:00Z");
  const open = trade("open", null, { exits: [], openPosition: { markPrice: 105 } });
  const trades = [trade("duplicate", "2026-01-01T00:00:00Z"), open, latest];
  assert.deepEqual(performance.filterTradesByPerformanceRange(trades), [open, latest]);
  assert.deepEqual(performance.filterTradesByPerformanceRange(trades, "all", now), [open, latest]);
  assert.equal(performance.calculateTradePerformance(performance.filterTradesByPerformanceRange(trades)).closedTrades, 1);
});

test("7天、15天、一个月30天和3个月90天包含今天，按 UTC+8 零点筛选", () => {
  const todayStart = Date.parse("2026-10-13T16:00:00Z");
  for (const [range, days] of [["7d", 7], ["15d", 15], ["1m", 30], ["3m", 90]]) {
    const start = todayStart - (days - 1) * dayMs;
    const trades = [trade("before", start - 1), trade("start", start), trade("now", now), trade("future", now + 1)];
    assert.deepEqual(performance.filterTradesByPerformanceRange(trades, range, now).map(item => item.id), ["start", "now"]);
  }
});

test("筛选使用最终平仓时刻，旧顶层退出时间兼容，部分平仓仍不进入表现", () => {
  const split = trade("split", null, {
    exits: [
      { quantity: 0.5, exitPrice: 112, exitTime: "2026-10-13T00:00:00Z" },
      { quantity: 0.5, exitPrice: 112, exitTime: "2026-09-01T00:00:00Z" },
    ],
  });
  const legacy = trade("legacy", null, { exits: undefined, exitPrice: 110, exitTime: "2026-10-14T00:00:00Z" });
  const partial = trade("partial", "2026-10-14T00:00:00Z", { quantity: 2 });
  const open = trade("open", "2026-10-14T00:00:00Z", { openPosition: { markPrice: 105 } });
  const invalid = trade("invalid", "无效时间");
  const result = performance.calculateTradePerformance(performance.filterTradesByPerformanceRange([split, legacy, partial, open, invalid], "7d", now));
  assert.deepEqual(result.points.map(item => item.tradeId), ["split", "legacy"]);
  assert.equal(result.closedTrades, 2);
});

test("先去重再筛选，最新记录移出范围或转为未平仓时不复活旧记录", () => {
  const recent = trade("duplicate", "2026-10-13T00:00:00Z");
  for (const latest of [trade("duplicate", "2026-09-01T00:00:00Z"), trade("duplicate", null, { exits: [] })]) {
    assert.deepEqual(performance.filterTradesByPerformanceRange([recent, latest], "7d", now), []);
  }
});

test("范围内的盈亏、费用、曲线、分布和持仓时间只使用筛选后的交易", () => {
  const recent = trade("recent", "2026-10-13T01:00:00Z", { entryTime: "2026-10-13T00:00:00Z" });
  const old = trade("old", "2026-07-01T00:00:00Z", { feesKnown: false });
  const original = structuredClone([old, recent]);
  const filtered = performance.filterTradesByPerformanceRange(original, "7d", now);
  const result = performance.calculateTradePerformance(filtered);
  assert.equal(result.totalPnl, 10);
  assert.equal(result.totalFees, 2);
  assert.equal(result.unknownFeeTrades, 0);
  assert.equal(result.points[0].cumulativePnl, 10);
  assert.deepEqual(result.daily.map(item => item.date), ["2026-10-13"]);
  assert.equal(result.profitPercentDistribution.reduce((sum, bin) => sum + bin.count, 0), 1);
  assert.equal(result.averageWinHoldingMs, 60 * 60 * 1000);
  assert.deepEqual(original, [old, recent]);
});

test("跨年和闰年范围不受机器时区影响，无交易范围返回空统计", () => {
  for (const reference of ["2027-01-01T16:01:00Z", "2028-03-01T16:01:00Z"]) {
    const referenceTime = Date.parse(reference);
    const start = Date.parse(reference.slice(0, 10) + "T16:00:00Z") - 6 * dayMs;
    assert.deepEqual(performance.filterTradesByPerformanceRange([trade("boundary", start), trade("old", start - 1)], "7d", referenceTime).map(item => item.id), ["boundary"]);
  }
  const result = performance.calculateTradePerformance(performance.filterTradesByPerformanceRange([trade("old", "2026-01-01T00:00:00Z")], "7d", now));
  assert.equal(result.closedTrades, 0);
  assert.equal(result.totalPnl, 0);
  assert.deepEqual(result.daily, []);
});

test("空档案安全返回，错误范围和无效参考时间明确拒绝", () => {
  assert.deepEqual(performance.filterTradesByPerformanceRange([], "7d", now), []);
  assert.throws(() => performance.filterTradesByPerformanceRange([], "unknown", now), /范围/);
  assert.throws(() => performance.filterTradesByPerformanceRange([], "7d", NaN), /时间/);
});
