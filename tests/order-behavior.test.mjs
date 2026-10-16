import assert from "node:assert/strict";
import test from "node:test";
import { analyzeApiOrderBehavior, getTradeEntryOrderBehaviors } from "../lib/order-behavior.mjs";
import { mergeBinanceOrderRecords, reconstructBinanceUsdmReplays } from "../lib/binance-orders.mjs";
import { createDesktopRepository } from "../desktop/database.mjs";

const start = Date.parse("2026-10-10T00:00:00Z");
const iso = seconds => new Date(start + seconds * 1000).toISOString();
function order(extra = {}) {
  return { userId: "synthetic-account", symbol: "BTCUSDT", orderId: "entry-1", sourceKind: "api-normal",
    orderType: "LIMIT", side: "BUY", positionSide: "LONG", limitPrice: 100, averagePrice: 100,
    originalQuantity: 2, executedQuantity: 2, executedQuoteQuantity: 200, stopPrice: null, status: "FILLED",
    createdAt: iso(0), updatedAt: iso(7200), fills: [fill("1", 3600), fill("2", 7200)],
    amendmentHistory: { status: "complete", checkedAt: iso(8000), changes: [] }, ...extra };
}
const fill = (tradeId, seconds, quantity = 1) => ({ tradeId, orderId: "entry-1", symbol: "BTCUSDT",
  side: "BUY", positionSide: "LONG", quantity, price: 100, quoteQuantity: quantity * 100,
  time: iso(seconds), commission: 0, commissionAsset: "USDT", maker: true });
const change = (seconds, beforePrice = 99, afterPrice = 100) => ({ amendmentId: "change-1",
  time: iso(seconds), beforePrice, afterPrice });

test("等待时长取创建至首笔成交，不取最终成交或状态更新时间", () => {
  const input = order(); const before = structuredClone(input);
  const result = analyzeApiOrderBehavior(input);
  assert.equal(result.waitMs, 3_600_000);
  assert.equal(result.firstFillTime, iso(3600));
  assert.equal(result.kind, "resting");
  assert.deepEqual(input, before);
});

test("新限价单快速成交只标客观行为，不推断突然决心或保证接近市价", () => {
  const result = analyzeApiOrderBehavior(order({ fills: [fill("1", 5, 2)] }));
  assert.equal(result.kind, "quick"); assert.equal(result.waitMs, 5000);
  assert.match(result.explanation, /不能确认.*决策|不代表.*决策/);
});

test("久挂后买价提高或卖价降低且很快成交，识别疑似追价并显示改价后等待", () => {
  for (const [side, beforePrice, afterPrice] of [["BUY", 99, 100], ["SELL", 101, 100]]) {
    const result = analyzeApiOrderBehavior(order({ side, amendmentHistory: {
      status: "complete", checkedAt: iso(8000), changes: [change(3594, beforePrice, afterPrice)],
    } }));
    assert.equal(result.kind, "chased"); assert.equal(result.lastChangeWaitMs, 6000);
    assert.match(result.label, /疑似/);
  }
});

test("背离成交方向的改价、仅改数量和首次成交之后的改价不冒充追价", () => {
  for (const changes of [[change(3594, 101, 100)], [change(3594, 100, 100)], [change(7194)]]) {
    assert.notEqual(analyzeApiOrderBehavior(order({ amendmentHistory: {
      status: "complete", checkedAt: iso(8000), changes,
    } })).kind, "chased");
  }
});

test("没有完整改单历史的久挂单保留真实时长，但不声称一直未改价", () => {
  for (const history of [undefined, { status: "unavailable", checkedAt: iso(8000), changes: [] },
    { status: "partial", checkedAt: iso(8000), changes: [] }]) {
    const result = analyzeApiOrderBehavior(order({ sourceKind: "okx-api-normal", amendmentHistory: history }));
    assert.equal(result.waitMs, 3_600_000); assert.equal(result.kind, "long-wait");
    assert.match(result.explanation, /追价.*未知|无法确认.*追价/);
  }
});

test("缺成交、部分成交历史、重复成交和异常时间均不能伪造首笔成交等待", () => {
  for (const fills of [undefined, [], [fill("1", 7200)], [fill("1", 7200), fill("1", 7200)],
    [fill("1", -1, 2)], [{ ...fill("1", 5, 2), time: "bad" }]]) {
    const result = analyzeApiOrderBehavior(order({ fills }));
    assert.equal(result.kind, "unknown"); assert.equal(result.waitMs, null);
  }
});

test("市价单和条件委托不使用创建至触发的时间当限价挂单等待", () => {
  assert.equal(analyzeApiOrderBehavior(order({ orderType: "MARKET" })).kind, "market");
  for (const extra of [{ orderType: "STOP" }, { sourceKind: "api-algo" }, { sourceKind: "okx-api-algo" }]) {
    const result = analyzeApiOrderBehavior(order(extra));
    assert.equal(result.kind, "conditional"); assert.equal(result.waitMs, null);
  }
});

test("CSV、OCR、聪明钱即使有相同时间字段也不进入 API 行为识别", () => {
  for (const source of ["binance-csv", "ocr-basic", "smart-money-public", "copy-trade-public"]) {
    assert.equal(analyzeApiOrderBehavior(order({ sourceKind: undefined, source })).kind, "unsupported");
  }
});

test("快速和久挂阈值可调，普通等待保留中间类别", () => {
  const input = order({ fills: [fill("1", 120, 2)] });
  assert.equal(analyzeApiOrderBehavior(input).kind, "waiting");
  assert.equal(analyzeApiOrderBehavior(input, { rapidFillMs: 120_000 }).kind, "quick");
  assert.equal(analyzeApiOrderBehavior(input, { longWaitMs: 120_000 }).kind, "resting");
});

test("Maker 成交不等于久挂，Taker 成交也不抹掉真实等待", () => {
  assert.equal(analyzeApiOrderBehavior(order({ fills: [fill("1", 1, 2)] })).kind, "quick");
  assert.equal(analyzeApiOrderBehavior(order({ fills: [
    { ...fill("1", 3600, 2), maker: false },
  ] })).waitMs, 3_600_000);
});

test("仅关联同用户同交易所同账户的入场订单，同一订单分批成交只显示一行", () => {
  const trade = { symbol: "BTCUSDT", side: "long", sourceAccountId: "synthetic-account", syncSources: ["binance-api"],
    entries: [{ sourceOrderId: "entry-1" }, { sourceOrderId: "entry-1" }] };
  const orders = [order(), order({ userId: "other-account" }), order({ profileId: "other-profile" }),
    order({ sourceKind: "okx-api-normal", exchangeProvider: "okx-swap" })];
  const rows = getTradeEntryOrderBehaviors(trade, orders);
  assert.equal(rows.length, 1); assert.equal(rows[0].provider, "binance-usdm");
  assert.equal(getTradeEntryOrderBehaviors({ ...trade, sourceAccountId: undefined }, orders)[0].kind, "unknown");
  assert.deepEqual(getTradeEntryOrderBehaviors({ ...trade, syncSources: ["smart-money-public"] }, orders), []);
});

test("API 重建保留稳定账户身份，行为分析不改变原有成交、盈亏与入场时间", () => {
  const entry = order(); const exit = order({ orderId: "exit-1", side: "SELL", reduceOnly: true,
    createdAt: iso(9000), updatedAt: iso(9001), fills: [{ ...fill("3", 9001, 2), orderId: "exit-1", side: "SELL" }] });
  const trades = reconstructBinanceUsdmReplays([entry, exit]).trades;
  assert.equal(trades.length, 1); assert.equal(trades[0].sourceAccountId, "synthetic-account");
  const before = structuredClone(trades[0]);
  assert.equal(getTradeEntryOrderBehaviors(trades[0], [entry, exit]).length, 1);
  assert.deepEqual(trades[0], before); assert.equal(trades[0].entryTime, iso(3600));
});

test("回放尚未到达的加仓和入场不提前显示行为，回退时移除未来订单", () => {
  const trade = { symbol: "BTCUSDT", sourceAccountId: "synthetic-account", syncSources: ["binance-api"],
    entries: [{ sourceOrderId: "entry-1", entryTime: iso(3600) }, { sourceOrderId: "entry-2", entryTime: iso(8000) }] };
  const orders = [order(), order({ orderId: "entry-2" })];
  assert.equal(getTradeEntryOrderBehaviors(trade, orders, { asOfTime: start }).length, 0);
  assert.equal(getTradeEntryOrderBehaviors(trade, orders, { asOfTime: start + 4000_000 }).length, 1);
  assert.equal(getTradeEntryOrderBehaviors(trade, orders, { asOfTime: start + 9000_000 }).length, 2);
});

test("改单补查失败或快速同步不会抹掉以前已保存的改价证据，SQLite 可恢复", () => {
  const original = order({ amendmentHistory: { status: "complete", checkedAt: iso(8000), changes: [change(3594)] } });
  const incoming = order({ amendmentHistory: { status: "unavailable", checkedAt: iso(9000), changes: [] } });
  const [merged] = mergeBinanceOrderRecords([original], [incoming]);
  assert.equal(merged.amendmentHistory.changes.length, 1);
  assert.equal(merged.amendmentHistory.status, "unavailable");
  const repository = createDesktopRepository(":memory:");
  try {
    repository.saveOrders([merged]);
    assert.equal(analyzeApiOrderBehavior(repository.loadState().orders[0]).kind, "chased");
  } finally { repository.close(); }
});
