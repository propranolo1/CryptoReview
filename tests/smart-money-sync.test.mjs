import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as profileDomain from "../lib/smart-money-profile.mjs";
import { normalizeTradeProfiles } from "../lib/trade-profiles.mjs";
import { readSmartMoneyTradeSnapshot } from "../lib/smart-money-sync.mjs";
import * as monitorDomain from "../lib/copy-trade-monitor.mjs";
import * as orderDomain from "../lib/binance-orders.mjs";
import { persistDesktopReplaySnapshot } from "../lib/replay-persistence.mjs";
import { createDesktopRepository } from "../desktop/database.mjs";
import { createSmartMoneySessionService } from "../desktop/smart-money-session.mjs";
import { NativeWindow } from "./fixtures/smart-money-window.mjs";

const ID = "1234567890123456789";
const sourceUrl = `https://www.binance.com/zh-CN/smart-money/profile/${ID}`;
const profilePayload = { topTraderId: ID, fetchedAt: "2026-10-04T03:00:00.000Z", profile: {
  topTraderId: ID, traderName: "合成测试", sharingPosition: true, sharingLatestRecord: true,
  futuresCopyTradePortfolioId: null,
} };

export async function compileCallback(name, dependencies) {
  const source = (await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const start = source.indexOf(`  const ${name} = useCallback(`);
  assert.ok(start >= 0, `真实组件缺少 ${name}`);
  const end = source.indexOf("\n  }, [", start);
  const close = source.indexOf("]);", end) + 3;
  const code = ts.transpileModule(`${source.slice(start, close)}\nreturn ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}

test("真实导入回调允许无带单关联，并将独立聪明钱配置交给同步入口", async () => {
  let saved;
  const calls = [];
  const profilesRef = { current: [] };
  const callback = await compileCallback("handleSmartMoneyImport", {
    useCallback: fn => fn, ...profileDomain, normalizeTradeProfiles,
    profiles: [], profilesRef,
    fetch: async () => Response.json(profilePayload),
    setProfiles: value => { saved = value; },
    setActiveProfileId() {}, setSelectedTradeIndex() {}, setPlaying() {}, setImportNotice() {},
    handleSmartMoneySync: async (...args) => { calls.push(args); },
    handlePublicLeadSync: async () => { assert.fail("无关联不能调用公开带单同步"); },
  });
  await callback(sourceUrl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].topTraderId, ID);
  assert.equal(calls[0][1].leadPortfolioId, null);
  assert.equal(saved.find(p => p.id === calls[0][0].id).smartMoneySource.topTraderId, ID);
  assert.deepEqual(profilesRef.current, saved);
});

const config = () => profileDomain.upsertSmartMoneyTradeProfile([], profileDomain.normalizeSmartMoneyProfileSnapshot(profilePayload)).profile.smartMoneySource;
const order = (side, price, offset) => ({ symbol: "BTCUSDT", side, positionSide: "LONG",
  avgPrice: price, executedQty: 1, updateTime: Date.parse(profilePayload.fetchedAt) + offset });
const latest = (extra = {}) => ({ authorizationRequired: false, fetchedAt: profilePayload.fetchedAt,
  positions: [], records: [order("BUY", 100, -2000), order("SELL", 110, -1000)], total: 2, warnings: [], ...extra });
const noPublic = async () => { assert.fail("没有真实关联不能请求公开带单 API"); };

test("无关联主页优先复用登录，成功时不弹窗口也不请求公开档案", async () => {
  const requests = [];
  const result = await readSmartMoneyTradeSnapshot(config(), { fetchImpl: noPublic, interactive: true,
    desktopApi: { syncSmartMoneyLatestRecords: async request => { requests.push(request); return latest(); },
      authorizeSmartMoney: async () => { assert.fail("已有登录不应重复授权"); } },
  });
  assert.equal(result.usingLatestRecords, true);
  assert.equal(result.snapshot.topTraderId, ID);
  assert.equal(result.snapshot.orders.length, 2);
  assert.equal("portfolioId" in result.snapshot, false);
  assert.deepEqual(requests, [{ topTraderId: ID, includePositions: true, includeLatestRecords: true }]);
});

test("明确未登录时手动打开官网窗口，自动同步只记录失败", async () => {
  let opened = 0;
  const desktopApi = {
    syncSmartMoneyLatestRecords: async () => ({ authorizationRequired: true, message: "合成未登录" }),
    authorizeSmartMoney: async request => { opened++; assert.equal(request.sourceUrl, sourceUrl); return { completed: true, syncResult: latest() }; },
  };
  await assert.rejects(readSmartMoneyTradeSnapshot(config(), { desktopApi }), /合成未登录/);
  assert.equal(opened, 0);
  assert.equal((await readSmartMoneyTradeSnapshot(config(), { desktopApi, interactive: true })).snapshot.orders.length, 2);
  assert.equal(opened, 1);
});

test("超时和禁止访问不会误当未登录重新授权或回退到猜造档案", async () => {
  for (const message of ["官网尚未返回完整数据", "合成403禁止访问"]) {
    await assert.rejects(readSmartMoneyTradeSnapshot(config(), { interactive: true, fetchImpl: noPublic,
      desktopApi: { syncSmartMoneyLatestRecords: async () => { throw new Error(message); },
        authorizeSmartMoney: async () => { assert.fail("普通错误不能强制登录"); } },
    }), new RegExp(message));
  }
});

test("用户取消或尚未完成登录会明确失败", async () => {
  for (const result of [{ completed: false }, { completed: true, syncResult: { authorizationRequired: true } }]) {
    await assert.rejects(readSmartMoneyTradeSnapshot(config(), { interactive: true,
      desktopApi: { syncSmartMoneyLatestRecords: async () => ({ authorizationRequired: true }), authorizeSmartMoney: async () => result },
    }), /取消|未完成/);
  }
});

test("只有真实关联才可读取公开成交，官网共享仓位覆盖关联仓位", async () => {
  const portfolioId = "2234567890123456789";
  const positions = [{ symbol: "BTCUSDT", positionAmount: 1, positionSide: "LONG", entryPrice: 100 }];
  const result = await readSmartMoneyTradeSnapshot({ ...config(), leadPortfolioId: portfolioId, sharingLatestRecord: false }, {
    desktopApi: { syncSmartMoneyLatestRecords: async () => latest({ positions, records: [], total: 0 }) }, fullHistory: true,
    fetchImpl: async (_url, request) => {
      assert.deepEqual(JSON.parse(request.body), { portfolioId, fullHistory: true });
      return Response.json({ portfolioId, fetchedAt: profilePayload.fetchedAt, orders: [order("BUY", 100, -2000)], positions: [] });
    },
  });
  assert.equal(result.usingLatestRecords, false);
  assert.equal(result.snapshot.positions.length, 1);
  assert.equal(result.snapshot.orders.length, 1);
  assert.equal("portfolioId" in result.snapshot, false);
});

test("无桌面桥接或只共享仓位时给出明确提示，不制造订单", async () => {
  await assert.rejects(readSmartMoneyTradeSnapshot(config(), { fetchImpl: noPublic }), /桌面版/);
  await assert.rejects(readSmartMoneyTradeSnapshot({ ...config(), sharingLatestRecord: false }, { fetchImpl: noPublic }), /仅仓位快照/);
});

test("官网单向空仓经过标准化和转换仍保持空头方向", async () => {
  const result = await readSmartMoneyTradeSnapshot(config(), {
    desktopApi: { syncSmartMoneyLatestRecords: async () => latest({ positions: [
      { symbol: "BTCUSDT", positionSide: "BOTH", positionAmount: -1, entryPrice: 100 },
    ] }) },
  });
  const positions = monitorDomain.createPublicLeadOpenPositions(result.snapshot, {
    profileId: "profile-test", profileName: "合成测试", source: "smart-money-public", sourceIdentity: ID,
  });
  assert.equal(positions[0].side, "short");
});

async function syncHarness(result = latest()) {
  const repository = createDesktopRepository(":memory:");
  const target = profileDomain.upsertSmartMoneyTradeProfile([], profileDomain.normalizeSmartMoneyProfileSnapshot(profilePayload)).profile;
  const state = { profiles: normalizeTradeProfiles([target]), orders: [], trades: [], result, notices: [], selected: [] };
  const profilesRef = { current: state.profiles };
  const tradesRef = { current: state.trades };
  const desktopApi = { syncSmartMoneyLatestRecords: async () => {
    if (state.result instanceof Error) throw state.result;
    return state.result;
  }, saveReplaySnapshot: async value => repository.saveReplaySnapshot(value),
  authorizeSmartMoney: async () => { assert.fail("自动同步不弹登录窗口"); } };
  const dependencies = { useCallback: fn => fn, ...profileDomain, ...monitorDomain, ...orderDomain,
    readSmartMoneyTradeSnapshot, persistDesktopReplaySnapshot, normalizeTradeProfiles,
    reconstructReplayableBinanceOrders: orderDomain.reconstructBinanceUsdmReplays,
    filterRecordsByTradeProfile: (records, id) => records.filter(record => record.profileId === id),
    profilesRef, tradesRef, publicLeadSyncingRef: { current: new Set() }, skipNextTradeAutoSaveRef: { current: null },
    mergeIntoOrderArchive: incoming => { state.orders = orderDomain.mergeBinanceOrderRecords(state.orders, incoming); return state.orders; },
    window: { cryptoReviewDesktop: desktopApi },
    setProfiles: value => { state.profiles = typeof value === "function" ? value(state.profiles) : value; repository.saveProfiles(state.profiles); },
    setTrades: value => { state.trades = value; }, setImportNotice: value => state.notices.push(value),
    setSelectedId: value => state.selected.push(value), setActiveProfileId() {}, setSelectedTradeIndex() {}, setActiveModule() {}, setPlaying() {},
  };
  dependencies.saveSmartMoneyConfig = await compileCallback("saveSmartMoneyConfig", dependencies);
  const sync = await compileCallback("handleSmartMoneySync", dependencies);
  return { sync, state, target, profilesRef, tradesRef, repository, dependencies };
}

test("真实同步回调写入 SQLite，重复与重启后的同步保持去重和用户隔离", async () => {
  const h = await syncHarness();
  try {
    await h.sync(h.target, h.target.smartMoneySource);
    assert.equal(h.repository.loadState().orders.length, 2);
    assert.equal(h.repository.loadState().trades.length, 1);
    assert.equal(h.repository.loadState().profiles.find(p => p.id === h.target.id).smartMoneySource.lastSyncedAt, profilePayload.fetchedAt);
    const firstId = h.state.trades[0].id;
    h.state.trades[0].notes = "保留合成笔记";
    const other = { ...h.state.orders[0], profileId: "profile-other", userId: "smart-money:3234567890123456789" };
    h.state.orders.push(other);
    h.profilesRef.current = normalizeTradeProfiles(JSON.parse(JSON.stringify(h.repository.loadState().profiles)));
    const restored = h.profilesRef.current.find(p => p.id === h.target.id);
    await h.sync(restored, restored.smartMoneySource, { silent: true });
    assert.equal(h.state.orders.length, 3);
    assert.equal(h.state.trades.length, 1);
    assert.equal(h.state.trades[0].id, firstId);
    assert.equal(h.state.trades[0].notes, "保留合成笔记");
    assert.equal(h.state.selected.length, 1);
  } finally { h.repository.close(); }
});

test("失败保留已存订单、复盘和上次成功状态，自动更新不打断图表", async () => {
  const h = await syncHarness();
  try {
    await h.sync(h.target, h.target.smartMoneySource);
    const before = h.repository.loadState();
    h.state.result = new Error("合成超时");
    await assert.rejects(h.sync(h.target, h.profilesRef.current.find(p => p.id === h.target.id).smartMoneySource, { silent: true }), /合成超时/);
    const after = h.repository.loadState();
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.trades, before.trades);
    const saved = after.profiles.find(p => p.id === h.target.id).smartMoneySource;
    assert.equal(saved.lastSyncedAt, profilePayload.fetchedAt);
    assert.equal(saved.lastError, "合成超时");
    assert.equal(h.state.notices.length, 1);
  } finally { h.repository.close(); }
});

test("最新30天只有开仓或仅仓位时不推断缺失成交链的未平仓回放", async () => {
  for (const records of [[order("BUY", 100, -2000)], []]) {
    const h = await syncHarness(latest({ records, total: records.length, positions: [] }));
    try { await h.sync(h.target, h.target.smartMoneySource); assert.equal(h.state.trades.length, 0); }
    finally { h.repository.close(); }
  }
});

test("解除绑定清除两种自动同步配置，但保留用户与已导入记录", async () => {
  const h = await syncHarness();
  try {
    await h.sync(h.target, h.target.smartMoneySource);
    h.dependencies.saveSmartMoneyConfig(h.target.id, null);
    const saved = h.profilesRef.current.find(p => p.id === h.target.id);
    assert.equal(saved.smartMoneySource, undefined);
    assert.equal(saved.copyTradeMonitor, undefined);
    assert.equal(h.repository.loadState().trades.length, 1);
  } finally { h.repository.close(); }
});

test("真实轮询 effect 支持没有 copyTradeMonitor 的来源，重启后按设置后台同步", async () => {
  const source = (await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const start = source.lastIndexOf("  useEffect(() => {\n    if (!hydrated || persistenceMode");
  assert.ok(start >= 0);
  const end = source.indexOf("\n\n  return (", start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const profile = profileDomain.upsertSmartMoneyTradeProfile([], profileDomain.normalizeSmartMoneyProfileSnapshot(profilePayload)).profile;
  for (const enabled of [true, false]) {
    const calls = [];
    const dependencies = { hydrated: true, persistenceMode: "desktop", profiles: [{ ...profile, smartMoneySource: { ...profile.smartMoneySource, enabled, intervalSeconds: 300, lastAttemptAt: new Date().toISOString() } }],
      useEffect: fn => fn(), window: { setTimeout: (fn, delay) => { assert.ok(delay > 290_000); fn(); return 1; }, clearTimeout() {} },
      handleSmartMoneySync: async (...args) => calls.push(args), handlePublicLeadSync: () => assert.fail("独立来源不能依赖带单轮询"),
    };
    new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
    assert.equal(calls.length, enabled ? 1 : 0);
    if (enabled) assert.equal(calls[0][2].silent, true);
  }
});

test("正式桌面会话跨两个主页复用同一个隐藏官网窗口和设备会话", async () => {
  NativeWindow.windows = [];
  let cleared = 0;
  const session = { clearStorageData: async () => { cleared++; }, flushStorageData() {}, cookies: { flushStore: async () => {} } };
  const service = createSmartMoneySessionService({ browserSession: session, BrowserWindow: NativeWindow,
    now: () => Date.parse(profilePayload.fetchedAt), syncTimeoutMs: 200, driveIntervalMs: 2 });
  NativeWindow.onDrive = null;
  NativeWindow.onLoad = window => {
    const id = /profile\/(\d+)/.exec(window.url)[1];
    window.respond("positions", { success: true, data: [] }, { id, rows: 9 });
    window.respond("order-history", { success: true, data: { data: [], total: 0 } }, { id });
  };
  try {
    const desktopApi = { syncSmartMoneyLatestRecords: request => service.syncLatestRecords(request), authorizeSmartMoney: request => service.authorize(request) };
    for (const id of [ID, "3234567890123456789"]) {
      const source = { ...config(), topTraderId: id, sourceUrl: sourceUrl.replace(ID, id) };
      assert.equal((await readSmartMoneyTradeSnapshot(source, { desktopApi, interactive: true })).snapshot.topTraderId, id);
    }
    assert.equal(NativeWindow.windows.length, 1);
    assert.equal(NativeWindow.current.options.webPreferences.session, session);
    assert.equal(NativeWindow.current.visible, false);
    assert.equal(cleared, 0);
  } finally { await service.dispose(); NativeWindow.onLoad = null; }
});
