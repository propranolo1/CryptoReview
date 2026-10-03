import assert from "node:assert/strict";
import test from "node:test";
import { buildTradeListRows, formatTradeHoldingTime, summarizeTradeListByToken } from "../lib/trade-list.mjs";
import { filterTradesByToken } from "../lib/trade-index.mjs";
import { filterTradesByCloseDate } from "../lib/performance.mjs";
import { filterRecordsByTradeProfile } from "../lib/trade-profiles.mjs";

const now = Date.parse("2026-10-01T12:00:00Z");
const hour = 3_600_000;
function trade(id, pnl, hours = 1, extra = {}) {
  return { id, symbol: "BTCUSDT", side: "long", quantity: 1, entryPrice: 1000,
    entryTime: new Date(now - hours * hour).toISOString(), fee: 0,
    exits: [{ quantity: 1, exitPrice: 1000 + pnl, exitTime: new Date(now).toISOString(), fee: 0 }], ...extra };
}
const ids = (rows) => rows.map((row) => row.trade.id);

test("持有时间取最早有效开仓至最终平仓，分批成交顺序不影响时长", () => {
  const item = trade("batch", 10, 2, {
    entries: [{ entryTime: new Date(now - 5 * hour).toISOString() }, { entryTime: "invalid" }],
    exits: [{ quantity: 0.5, exitPrice: 1010, exitTime: new Date(now).toISOString() },
      { quantity: 0.5, exitPrice: 1010, exitTime: new Date(now - hour).toISOString() }],
  });
  assert.equal(buildTradeListRows([item], { now })[0].holdingMs, 5 * hour);
});

test("持有时间升降序都把无效时间放在末尾，同值稳定且不修改输入", () => {
  const items = Object.freeze([trade("long", 10, 8), trade("short", 20),
    trade("same", 5), trade("unknown", 1, 1, { entryTime: null })].map(Object.freeze));
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "holding", direction: "asc", now })), ["short", "same", "long", "unknown"]);
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "holding", direction: "desc", now })), ["long", "short", "same", "unknown"]);
  assert.deepEqual(items.map((item) => item.id), ["long", "short", "same", "unknown"]);
});

test("金额按带正负号的实际盈亏升降序排列，零值位于赚亏之间", () => {
  const items = [trade("loss", -20), trade("large", 100), trade("zero", 0), trade("small", 5)];
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "pnl", direction: "desc" })), ["large", "small", "zero", "loss"]);
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "pnl", direction: "asc" })), ["loss", "zero", "small", "large"]);
});

test("金额同值稳定，无效金额在升降序下均置后", () => {
  const items = [trade("a", -5), trade("bad", 1, 1, { entryPrice: NaN }), trade("b", -5), trade("win", 10)];
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "pnl", direction: "asc" })), ["a", "b", "win", "bad"]);
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "pnl", direction: "desc" })), ["win", "a", "b", "bad"]);
});

test("日期按最终平仓时间排列，未平仓用最早入场时间，无效时间置后", () => {
  const items = [trade("new", 10), trade("old", 1, 5, { exits: [{ quantity: 1, exitPrice: 1001, exitTime: new Date(now - 3 * hour).toISOString() }] }),
    trade("open", 0, 2, { exits: [], openPosition: { markPrice: 1000 } }),
    trade("unknown", 10, 1, { exits: [], exitTime: "invalid" })];
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "date", direction: "asc" })), ["old", "open", "new", "unknown"]);
  assert.deepEqual(ids(buildTradeListRows(items, { sortBy: "date", direction: "desc" })), ["new", "open", "old", "unknown"]);
});

test("排序和着色使用原盈亏计算，保留空仓方向、手续费、资金费及仓位快照", () => {
  const items = [trade("fees", 20, 1, { fee: 25 }),
    trade("short", -10, 1, { side: "short", fundingFee: -2 }),
    trade("open", 0, 3, { exits: [], openPosition: { markPrice: 1100 } })];
  const rows = buildTradeListRows(items, { sortBy: "pnl", now });
  assert.deepEqual(ids(rows), ["open", "short", "fees"]);
  assert.deepEqual(rows.map((row) => row.pnl.totalPnl), [100, 8, -5]);
  assert.equal(rows[0].holdingMs, 3 * hour);
  assert.equal(rows[0].tone, "profit");
  assert.equal(rows[2].tone, "loss");
});

test("未平仓持有时间算到指定当前时间，未来开仓或倒置时间不猜测", () => {
  const items = [trade("open", 0, 2, { exits: [], openPosition: { markPrice: 1000 } }),
    trade("future", 0, -1, { exits: [], openPosition: { markPrice: 1000 } }),
    trade("inverted", 1, -1)];
  assert.deepEqual(buildTradeListRows(items, { now }).map((row) => row.holdingMs), [2 * hour, null, null]);
});

test("盈亏金额越大颜色强度越高，等额盈亏同强度，零值保持中性", () => {
  const items = [trade("large", 100), trade("small", 1), trade("lossLarge", -100), trade("lossSmall", -1), trade("zero", 0)];
  const rows = buildTradeListRows(items);
  assert.deepEqual(rows.map((row) => row.tone), ["profit", "profit", "loss", "loss", "neutral"]);
  assert.ok(rows[0].intensity > rows[1].intensity);
  assert.ok(rows[2].intensity > rows[3].intensity);
  assert.equal(rows[0].intensity, rows[2].intensity);
  assert.equal(rows[4].intensity, 0);
  assert.ok(rows.every((row) => Number.isFinite(row.intensity) && row.intensity >= 0 && row.intensity <= 1));
});

test("默认保持原排列，空列表、无效盈亏和极小金额不产生无效颜色", () => {
  const items = [trade("a", 0), trade("bad", 10, 1, { entryPrice: NaN }), trade("tiny", 0.000001)];
  const rows = buildTradeListRows(items);
  assert.deepEqual(ids(rows), items.map((item) => item.id));
  assert.equal(rows[1].pnl, null);
  assert.equal(rows[1].tone, "neutral");
  assert.equal(rows[1].intensity, 0);
  assert.deepEqual(buildTradeListRows([]), []);
  assert.ok(rows.every((row) => Number.isFinite(row.intensity)));
  assert.doesNotThrow(() => buildTradeListRows([trade("old", 1, 1, { entries: [null] })]));
});

test("日期、代币、星标与复盘用户筛选后的排序和颜色只使用当前列表", () => {
  const items = [trade("btc", 10, 1, { profileId: "a", starred: true }),
    trade("eth", 100, 1, { profileId: "a", symbol: "ETHUSDT" }),
    trade("other", 900, 1, { profileId: "b" })];
  const current = filterRecordsByTradeProfile(items, "a");
  const filtered = filterTradesByToken(filterTradesByCloseDate(current, "2026-10-01"), "BTC").filter((item) => item.starred);
  const rows = buildTradeListRows(filtered, { sortBy: "pnl" });
  assert.deepEqual(ids(rows), ["btc"]);
  assert.equal(rows[0].intensity, 1);
});

test("持有时间标签区分未知、分钟、小时与天", () => {
  assert.equal(formatTradeHoldingTime(null), "—");
  assert.equal(formatTradeHoldingTime(30_000), "不足 1 分钟");
  assert.equal(formatTradeHoldingTime(5 * 60_000), "5 分钟");
  assert.equal(formatTradeHoldingTime(hour + 5 * 60_000), "1 小时 5 分钟");
  assert.equal(formatTradeHoldingTime(50 * hour), "2 天 2 小时");
});

test("代币总盈亏汇总该币的全部交易，并沿用单笔手续费、资金费与未平仓估值", () => {
  const items = [trade("btc-win", 100, 1, { fee: 2 }),
    trade("btc-loss", -30, 1, { symbol: "BTCUSDC", fundingFee: -1 }),
    trade("btc-open", 0, 1, { exits: [], openPosition: { markPrice: 1050 } }),
    trade("eth", -10, 1, { symbol: "ETHUSDT" })];
  const groups = summarizeTradeListByToken(items);
  assert.deepEqual(groups, [
    { token: "BTC", count: 3, totalPnl: 117, hasOpenPositions: true },
    { token: "ETH", count: 1, totalPnl: -10, hasOpenPositions: false },
  ]);
});

test("代币总盈亏只读取当前用户，损坏金额显示未知而非错误总额", () => {
  const items = [trade("a", 10, 1, { profileId: "a" }),
    trade("b", 900, 1, { profileId: "b" }),
    trade("bad", 10, 1, { profileId: "a", symbol: "ETHUSDT", entryPrice: NaN }),
    trade("eth", 20, 1, { profileId: "a", symbol: "ETHUSDT" })];
  const groups = summarizeTradeListByToken(filterRecordsByTradeProfile(items, "a"));
  assert.equal(groups[0].totalPnl, 10);
  assert.equal(groups[1].totalPnl, null);
  assert.equal(groups[1].count, 2);
  assert.deepEqual(summarizeTradeListByToken([]), []);
});
