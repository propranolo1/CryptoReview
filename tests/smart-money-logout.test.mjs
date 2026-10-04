import assert from "node:assert/strict";
import test from "node:test";
import { NativeWindow } from "./fixtures/smart-money-window.mjs";
import { createSmartMoneySessionService } from "../desktop/smart-money-session.mjs";
import { readSmartMoneyTradeSnapshot } from "../lib/smart-money-sync.mjs";

const ID = "1234567890123456789";
const target = { topTraderId: ID, includePositions: true, includeLatestRecords: true };
const config = { topTraderId: ID, sourceUrl: `https://www.binance.com/zh-CN/smart-money/profile/${ID}`,
  leadPortfolioId: null, sharingPosition: true, sharingLatestRecord: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
function respond(window) {
  window.respond("positions", { success: true, data: [] }, { id: ID, rows: 9 });
  window.respond("order-history", { success: true, data: { data: [], total: 0 } }, { id: ID });
}
function setup(options = {}) {
  NativeWindow.windows = [];
  NativeWindow.onLoad = null;
  NativeWindow.onDrive = null;
  let clearCalls = 0;
  const service = createSmartMoneySessionService({
    browserSession: { clearStorageData: async () => { clearCalls++; } },
    BrowserWindow: NativeWindow, syncTimeoutMs: 30, authorizationTimeoutMs: 100, driveIntervalMs: 2,
    ...options,
  });
  return { service, clearCalls: () => clearCalls };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ value }), error => ({ error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), 250); }),
    ]);
  } finally { clearTimeout(timer); }
}

test("退出后后台同步立即要求重新登录，不再创建隐藏窗口等待官网数据", async () => {
  const { service, clearCalls } = setup();
  NativeWindow.onLoad = respond;
  try {
    await service.syncLatestRecords(target);
    await service.logout();
    NativeWindow.onLoad = null;
    const result = await service.syncLatestRecords(target);
    assert.equal(result.authorizationRequired, true);
    assert.equal(NativeWindow.windows.length, 1);
    assert.equal(clearCalls(), 1);
  } finally { await service.dispose(); }
});

test("退出后手动同步打开可见登录窗口，成功后下一次继续复用该窗口", async () => {
  const { service } = setup();
  let authorizations = 0;
  const desktopApi = {
    syncSmartMoneyLatestRecords: options => service.syncLatestRecords(options),
    authorizeSmartMoney: options => { authorizations++; return service.authorize(options); },
  };
  try {
    await service.logout();
    NativeWindow.onLoad = window => {
      assert.equal(window.visible, true, "退出后的首次读取必须让用户看到官网登录窗口");
      respond(window);
    };
    const result = await readSmartMoneyTradeSnapshot(config, { desktopApi, interactive: true });
    assert.equal(result.snapshot.topTraderId, ID);
    assert.equal(authorizations, 1);
    assert.equal(NativeWindow.current.visible, false);
    NativeWindow.onLoad = respond;
    await readSmartMoneyTradeSnapshot(config, { desktopApi, interactive: true });
    assert.equal(authorizations, 1);
    assert.equal(NativeWindow.windows.length, 1);
  } finally { await service.dispose(); }
});

test("退出后取消登录不会清除重新登录要求，也不会留下同步锁", async () => {
  const { service } = setup();
  try {
    await service.logout();
    const authorization = service.authorize(target);
    await tick();
    NativeWindow.current.close();
    assert.deepEqual(await authorization, { completed: false });
    const result = await service.syncLatestRecords(target);
    assert.equal(result.authorizationRequired, true);
    NativeWindow.onLoad = respond;
    assert.equal((await service.authorize(target)).syncResult.authorizationRequired, false);
  } finally { await service.dispose(); }
});

test("页面加载未结束时退出会取消旧同步，释放锁后可以重新登录", async () => {
  let releaseLoad;
  const loading = new Promise(resolve => { releaseLoad = resolve; });
  let stalled = true;
  class LoadingWindow extends NativeWindow {
    async loadURL(url) {
      if (stalled) await loading;
      if (!this.destroyed) await super.loadURL(url);
    }
  }
  const { service } = setup({ BrowserWindow: LoadingWindow });
  const pending = service.authorize(target);
  const outcome = bounded(pending);
  try {
    await tick();
    assert.deepEqual(await service.logout(), { cleared: true });
    assert.deepEqual(await outcome, { value: { completed: false } });
    stalled = false;
    NativeWindow.onLoad = respond;
    assert.equal((await service.authorize(target)).syncResult.authorizationRequired, false);
  } finally { releaseLoad(); await pending; await service.dispose(); }
});

test("官网加载一直不完成时同步会超时退出，并允许重试", async () => {
  let releaseLoad;
  const loading = new Promise(resolve => { releaseLoad = resolve; });
  let stalled = true;
  class LoadingWindow extends NativeWindow {
    async loadURL(url) {
      if (stalled) await loading;
      if (!this.destroyed) await super.loadURL(url);
    }
  }
  const { service } = setup({ BrowserWindow: LoadingWindow });
  const pending = service.syncLatestRecords(target);
  const outcome = bounded(pending);
  try {
    const result = await outcome;
    assert.match(result.error?.message ?? "仍在等待", /页面.*超时/);
    stalled = false;
    NativeWindow.onLoad = respond;
    assert.equal((await service.syncLatestRecords(target)).authorizationRequired, false);
  } finally { releaseLoad(); await pending.catch(() => {}); await service.dispose(); }
});

test("同时从两个入口退出只清理一次，清理结束前不能重新同步", async () => {
  let completeClear;
  const clearing = new Promise(resolve => { completeClear = resolve; });
  let clears = 0;
  const { service } = setup({ browserSession: { clearStorageData: async () => { clears++; await clearing; } } });
  const first = service.logout();
  const second = service.logout();
  try {
    await assert.rejects(service.authorize(target), /正在退出/);
    completeClear();
    await Promise.all([first, second]);
    assert.equal(clears, 1);
    assert.equal((await service.syncLatestRecords(target)).authorizationRequired, true);
  } finally { completeClear(); await service.dispose(); }
});
