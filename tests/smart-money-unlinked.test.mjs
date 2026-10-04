import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { normalizeSmartMoneyProfileSnapshot, upsertSmartMoneyTradeProfile } from "../lib/smart-money-profile.mjs";
import { normalizeTradeProfiles } from "../lib/trade-profiles.mjs";
import { createPublicLeadOrderRecords, createPublicLeadOpenPositions, normalizePublicLeadSnapshot } from "../lib/copy-trade-monitor.mjs";

const ID = "1234567890123456789";
const LINK = "2234567890123456789";
const fetchedAt = "2026-10-04T03:00:00.000Z";
const payload = (extra = {}) => ({ code: "000000", success: true, data: {
  topTraderId: ID, traderName: "合成聪明钱", sharingPosition: true,
  sharingLatestRecord: true, futuresCopyTradePortfolioId: null, ...extra,
} });

async function routeHarness(data) {
  const source = await readFile(new URL("../app/api/smart-money/profile/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function("require", "exports", "fetch", compiled)(() => ({ NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
  } }), exports, async url => {
    assert.equal(new URL(url).hostname, "www.binance.com");
    assert.equal(new URL(url).pathname, "/bapi/asset/v1/friendly/future/smart-money/profile");
    return Response.json(data);
  });
  return exports.POST(new Request("http://localhost/api/smart-money/profile", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topTraderId: ID }),
  }));
}

test("已分享最新操作的主页没有公开带单关联也能通过真实资料路由", async () => {
  const response = await routeHarness(payload());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.futuresCopyTradePortfolioId, null);
});

test("放宽关联限制仍拒绝错主页身份和非空的损坏关联 ID", async () => {
  assert.equal((await routeHarness(payload({ topTraderId: LINK }))).status, 502);
  assert.equal((await routeHarness(payload({ futuresCopyTradePortfolioId: "invalid" }))).status, 422);
});

test("无关联聪明钱以主页 ID 创建独立用户并在重启后保留来源和同步设置", () => {
  const snapshot = normalizeSmartMoneyProfileSnapshot(payload(), { topTraderId: ID, fetchedAt });
  assert.equal(snapshot.leadPortfolioId, null);
  const first = upsertSmartMoneyTradeProfile([], snapshot);
  assert.equal(first.profile.id, `profile-smart-money-${ID}`);
  assert.equal(first.profile.copyTradeMonitor, undefined);
  const saved = { ...first.profile, smartMoneySource: { ...first.profile.smartMoneySource,
    enabled: false, intervalSeconds: 300, lastSyncedAt: fetchedAt, lastError: "合成错误",
    cookie: "不应保留", lastSnapshot: { fetchedAt, positions: [] },
  } };
  const restored = normalizeTradeProfiles(JSON.parse(JSON.stringify([saved]))).find(profile => profile.id === first.profile.id);
  assert.equal(restored.smartMoneySource.topTraderId, ID);
  assert.equal(restored.smartMoneySource.enabled, false);
  assert.equal(restored.smartMoneySource.intervalSeconds, 300);
  assert.equal(restored.smartMoneySource.lastSyncedAt, fetchedAt);
  assert.equal(restored.smartMoneySource.lastError, "合成错误");
  assert.deepEqual(restored.smartMoneySource.lastSnapshot, { fetchedAt, positions: [] });
  assert.doesNotMatch(JSON.stringify(restored), /cookie|不应保留/);
  const second = upsertSmartMoneyTradeProfile([restored], { ...snapshot, fetchedAt: "2026-10-04T04:00:00.000Z" });
  assert.equal(second.created, false);
  assert.equal(second.profiles.length, 1);
  assert.equal(second.profile.smartMoneySource.intervalSeconds, 300);
  assert.equal(second.profile.smartMoneySource.enabled, false);
});

test("旧关联用户的监控设置可迁移，关联消失后不伪造带单配置且保持原订单身份", () => {
  const old = upsertSmartMoneyTradeProfile([], normalizeSmartMoneyProfileSnapshot(payload({ futuresCopyTradePortfolioId: LINK }), { fetchedAt })).profile;
  delete old.smartMoneySource.enabled;
  delete old.smartMoneySource.intervalSeconds;
  delete old.smartMoneySource.orderIdentity;
  old.copyTradeMonitor = { ...old.copyTradeMonitor, enabled: false, intervalSeconds: 30, lastSyncedAt: fetchedAt };
  const restored = normalizeTradeProfiles([old]).find(profile => profile.id === old.id);
  assert.equal(restored.smartMoneySource.enabled, false);
  assert.equal(restored.smartMoneySource.intervalSeconds, 30);
  assert.equal(restored.smartMoneySource.orderIdentity, LINK);
  const updated = upsertSmartMoneyTradeProfile([restored], normalizeSmartMoneyProfileSnapshot(payload(), { fetchedAt })).profile;
  assert.equal(updated.copyTradeMonitor, undefined);
  assert.equal(updated.smartMoneySource.orderIdentity, LINK);
  assert.equal(updated.smartMoneySource.lastSyncedAt, fetchedAt);
});

test("新用户以后出现真实带单关联也保持原操作事件身份", () => {
  const first = upsertSmartMoneyTradeProfile([], normalizeSmartMoneyProfileSnapshot(payload(), { fetchedAt })).profile;
  const next = upsertSmartMoneyTradeProfile([first], normalizeSmartMoneyProfileSnapshot(payload({ futuresCopyTradePortfolioId: LINK }), { fetchedAt })).profile;
  assert.equal(first.smartMoneySource.orderIdentity, ID);
  assert.equal(next.smartMoneySource.orderIdentity, ID);
  assert.equal(next.copyTradeMonitor.portfolioId, LINK);
});

test("官网最新操作与仓位无需 portfolioId 即可进入原订单格式，重复同步稳定且账户隔离", () => {
  const snapshot = { topTraderId: ID, fetchedAt, orders: [{ symbol: "BTCUSDT", side: "BUY", positionSide: "LONG",
    executedQty: 1, avgPrice: 100, updateTime: Date.parse(fetchedAt) - 3_600_000 }],
    positions: [{ symbol: "BTCUSDT", positionSide: "LONG", positionAmount: 1, entryPrice: 100, markPrice: 105 }],
  };
  const options = { profileId: `profile-smart-money-${ID}`, profileName: "合成测试", source: "smart-money-public", sourceIdentity: ID };
  const first = createPublicLeadOrderRecords(snapshot, options);
  const second = createPublicLeadOrderRecords(snapshot, options);
  assert.equal(first[0].userId, `smart-money:${ID}`);
  assert.equal(first[0].orderId, second[0].orderId);
  assert.equal(first[0].reduceOnly, false);
  assert.equal(createPublicLeadOpenPositions(snapshot, options)[0].quantity, 1);
  assert.throws(() => createPublicLeadOrderRecords(snapshot, { ...options, sourceIdentity: LINK }), /身份/);
  assert.throws(() => createPublicLeadOrderRecords(snapshot, { ...options, source: "copy-trade-public" }), /聪明钱/);
});

test("只有仓位但没有最新操作或关联成交时拒绝推测买卖记录", () => {
  assert.throws(() => normalizeSmartMoneyProfileSnapshot(payload({ sharingLatestRecord: false }), { fetchedAt }), /未共享最新操作/);
});

test("已迁移的聪明钱配置清除错误后不恢复旧带单错误", () => {
  const profile = upsertSmartMoneyTradeProfile([], normalizeSmartMoneyProfileSnapshot(payload({ futuresCopyTradePortfolioId: LINK }), { fetchedAt })).profile;
  profile.copyTradeMonitor.lastError = "旧合成错误";
  const restored = normalizeTradeProfiles([profile]).find(p => p.id === profile.id);
  assert.equal(restored.smartMoneySource.lastError, undefined);
});

test("旧关联订单切换到独立聪明钱快照后保留原订单号", () => {
  const activity = { fetchedAt, orders: [{ symbol: "BTCUSDT", side: "BUY", positionSide: "LONG",
    executedQty: 1, avgPrice: 100, updateTime: Date.parse(fetchedAt) }], positions: [] };
  const options = { profileId: `profile-smart-money-${ID}`, profileName: "合成测试", source: "smart-money-public", sourceIdentity: ID };
  const old = createPublicLeadOrderRecords(normalizePublicLeadSnapshot({ ...activity, portfolioId: LINK }), options);
  const migrated = createPublicLeadOrderRecords({ ...activity, topTraderId: ID }, { ...options, orderIdentity: LINK });
  assert.equal(migrated[0].orderId, old[0].orderId);
});
