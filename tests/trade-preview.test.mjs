import assert from "node:assert/strict";
import test from "node:test";
import { buildTradePreviewPlan, buildTradePreviewPlot, createTradePreviewController, getTradePreviewPosition } from "../lib/trade-preview.mjs";

const start = Date.parse("2026-09-20T00:00:00Z");
const minute = 60_000;
const iso = (time) => new Date(time).toISOString();
const trade = (extra = {}) => ({ id: "fixture", symbol: "BTCUSDT", side: "long", quantity: 2,
  entryTime: iso(start), entryPrice: 100, fee: 0,
  exits: [{ exitTime: iso(start + 100 * minute), exitPrice: 110, quantity: 2, fee: 0 }], ...extra });
const now = start + 30 * 86400_000;
const candle = (time, close = 103, intervalMs = minute) => ({ time: time / 1000, close, open: 100, high: Math.max(105, close), low: 95, volume: 10, closeTime: time + intervalMs - 1 });

test("短持仓前后各留 10% 行情，长持仓自动改用粗周期并覆盖完整交易", () => {
  const short = buildTradePreviewPlan(trade(), now);
  assert.equal(short.interval, "1m");
  assert.equal(short.startTime, start - 10 * minute);
  assert.equal(short.endTime, start + 110 * minute);
  assert.equal(short.holdingMs, 100 * minute);
  const long = buildTradePreviewPlan(trade({ exits: [{ exitTime: iso(start + 20 * 86400_000), exitPrice: 90, quantity: 2 }] }), now);
  assert.equal(long.interval, "4h");
  assert.ok((long.endTime - long.startTime) / long.intervalMs <= 182);
  assert.ok(long.startTime < long.entryTime && long.endTime > long.tradeEndTime);
});

test("分批成交使用最早建仓与最终平仓，空单 S 开仓 B 平仓，旧记录兼容顶层字段", () => {
  const entries = [0, 20].map((offset, index) => ({ id: String(index), quantity: 1, entryPrice: 100 + index, entryTime: iso(start + offset * minute), fee: 0 }));
  const plan = buildTradePreviewPlan(trade({ side: "short", entryTime: iso(start + 20 * minute), entries,
    exits: [{ quantity: 1, exitPrice: 98, exitTime: iso(start + 50 * minute) }, { quantity: 1, exitPrice: 95, exitTime: iso(start + 100 * minute) }] }), now);
  assert.equal(plan.entryTime, start);
  assert.deepEqual(plan.events.map((event) => event.side), ["sell", "sell", "buy", "buy"]);
  assert.equal(plan.events[3].price, 95);
  const legacy = buildTradePreviewPlan(trade({ exits: [], exitTime: iso(start + minute), exitPrice: 110 }), now);
  assert.equal(legacy.events.length, 2);
});

test("未平仓只展示到当前时间，无有效入场时间拒绝猜测", () => {
  const current = start + 5 * minute;
  const plan = buildTradePreviewPlan(trade({ openPosition: {}, exits: [] }), current);
  assert.equal(plan.endTime, current);
  assert.equal(plan.tradeEndTime, current);
  assert.equal(plan.open, true);
  assert.ok(plan.startTime < start);
  assert.throws(() => buildTradePreviewPlan(trade({ entryTime: null }), now), /入场时间/);
});

test("极短交易保留最小上下文，周线请求包含覆盖窗口起点的前一根", () => {
  const instant = buildTradePreviewPlan(trade({ exits: [{ quantity: 2, exitPrice: 101, exitTime: iso(start) }] }), now);
  assert.equal(instant.startTime, start - minute);
  assert.equal(instant.endTime, start + minute);
  const ancient = Date.parse("2020-01-01T00:00:00Z");
  const weekly = buildTradePreviewPlan(trade({ entryTime: iso(ancient), exits: [{ quantity: 2, exitPrice: 110, exitTime: iso(start) }] }), now);
  assert.equal(weekly.interval, "1w");
  assert.equal(weekly.requestStartTime, weekly.startTime - weekly.intervalMs);
  assert.ok(weekly.limit < 1000);
});

test("缩略图按真实成交时间和价格投影，密集点合并保留明细，缺行情不补价格", () => {
  const plan = buildTradePreviewPlan(trade({ entries: [0, 1].map((index) => ({ id: String(index), entryTime: iso(start + index * 1000), entryPrice: 100, quantity: 1 })) }), now);
  const candles = Array.from({ length: 121 }, (_, index) => candle(plan.startTime + index * minute));
  const plot = buildTradePreviewPlot(candles, plan);
  assert.ok(plot.path.startsWith("M"));
  assert.equal(plot.markers.length, 2);
  assert.equal(plot.markers[0].events.length, 2);
  assert.equal(plot.markers[0].quantity, 2);
  assert.equal(plot.markers[0].price, 100);
  assert.ok(plot.markers[0].x < plot.markers[1].x);
  assert.ok(plot.markers[0].y > plot.markers[1].y);
  assert.throws(() => buildTradePreviewPlot([], plan), /行情/);
  assert.throws(() => buildTradePreviewPlot(candles.slice(30), plan), /覆盖完整/);
  const gap = buildTradePreviewPlot(candles.filter((_, index) => index !== 50), plan);
  assert.equal((gap.path.match(/M/g) ?? []).length, 2);
  assert.match(gap.notice, /行情缺失/);
});

test("弹窗固定 380×220 并避开窗口底部和右侧边界", () => {
  assert.deepEqual(getTradePreviewPosition({ right: 300, left: 20, top: 800 }, { width: 1600, height: 900 }), { left: 308, top: 672 });
  assert.deepEqual(getTradePreviewPosition({ right: 980, left: 700, top: 20 }, { width: 1000, height: 600 }), { left: 312, top: 20 });
});

function harness(fetchImpl, clock = () => now) {
  let nextId = 0;
  const timers = new Map(), states = [];
  const controller = createTradePreviewController({ fetchImpl, now: clock, onChange: (state) => states.push(state),
    setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; }, clearTimer: (id) => timers.delete(id) });
  return { controller, states, flush(delay) { const pending = [...timers].filter(([, value]) => value.delay === delay); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, value]) => value.fn()); } };
}
const bounds = { right: 300, left: 20, top: 100 }, viewport = { width: 1600, height: 900 };
const response = (value) => { const plan = buildTradePreviewPlan(value, now); return { ok: true, json: async () => ({ symbol: value.symbol, interval: plan.interval, source: "Binance Spot", candles: Array.from({ length: 121 }, (_, index) => candle(plan.startTime + index * minute)) }) }; };
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

test("快速划过不请求行情，停留 300ms 后加载；进入小图保持，离开后关闭", async () => {
  let loads = 0;
  const h = harness(async () => { loads++; return response(trade()); });
  h.controller.enter(trade(), bounds, viewport);
  h.controller.leave(); h.flush(300);
  assert.equal(loads, 0);
  h.controller.enter(trade(), bounds, viewport); h.flush(300); await settle();
  assert.equal(loads, 1);
  assert.equal(h.states.at(-1).status, "ready");
  h.controller.leave(); h.controller.retain(); h.flush(150);
  assert.equal(h.states.at(-1).status, "ready");
  h.controller.leave(); h.flush(150);
  assert.equal(h.states.at(-1), null);
  h.controller.dispose();
});

test("切换悬停取消旧请求，迟到响应不能串图；已平仓缓存复用，记录变化重新加载", async () => {
  const requests = [];
  const h = harness((url, { signal }) => new Promise((resolve) => requests.push({ url, signal, resolve })));
  const a = trade(), b = trade({ id: "second", symbol: "ETHUSDT" });
  h.controller.enter(a, bounds, viewport); h.flush(300);
  h.controller.enter(b, bounds, viewport); h.flush(300);
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(response(b)); await settle();
  requests[0].resolve(response(a)); await settle();
  assert.equal(h.states.at(-1).trade.id, b.id);
  h.controller.close(); h.controller.enter(b, bounds, viewport); h.flush(300); await settle();
  assert.equal(requests.length, 2);
  h.controller.close(); h.controller.enter({ ...b, entryPrice: 99 }, bounds, viewport); h.flush(300);
  assert.equal(requests.length, 3);
  h.controller.dispose();
  assert.equal(requests[2].signal.aborted, true);
});

test("行情失败显示错误、再次悬停可重试；未平仓缓存一分钟后刷新", async () => {
  let loads = 0, current = now;
  const value = trade({ openPosition: {}, exits: [] });
  const h = harness(async () => {
    loads++;
    if (loads === 1) return { ok: false, json: async () => ({ message: "行情暂时不可用" }) };
    const plan = buildTradePreviewPlan(value, current);
    return { ok: true, json: async () => ({ symbol: value.symbol, interval: plan.interval, candles: [{ ...candle(plan.startTime, 100, plan.intervalMs) }, { ...candle(Math.floor(current / plan.intervalMs) * plan.intervalMs, 105, plan.intervalMs) }] }) };
  }, () => current);
  h.controller.enter(value, bounds, viewport); h.flush(300); await settle();
  assert.equal(h.states.at(-1).status, "error");
  assert.match(h.states.at(-1).message, /暂时不可用/);
  h.controller.close(); h.controller.enter(value, bounds, viewport); h.flush(300); await settle();
  assert.equal(h.states.at(-1).status, "ready");
  h.controller.close(); h.controller.enter(value, bounds, viewport); h.flush(300); await settle();
  assert.equal(loads, 2);
  current += 61_000;
  h.controller.close(); h.controller.enter(value, bounds, viewport); h.flush(300); await settle();
  assert.equal(loads, 3);
  h.controller.dispose();
});

test("响应交易对不匹配和缺少持仓行情时拒绝展示，关闭后不再回写状态", async () => {
  const h = harness(async () => ({ ...response(trade()), json: async () => ({ symbol: "ETHUSDT", candles: [] }) }));
  h.controller.enter(trade(), bounds, viewport); h.flush(300); await settle();
  assert.equal(h.states.at(-1).status, "error");
  assert.match(h.states.at(-1).message, /交易对/);
  h.controller.dispose();
});
