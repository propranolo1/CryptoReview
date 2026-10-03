import assert from "node:assert/strict";
import { NativeWindow } from "./fixtures/smart-money-window.mjs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSmartMoneySessionService } from "../desktop/smart-money-session.mjs";
import { createSmartMoneyPageAction, parseSmartMoneyRequest } from "../desktop/smart-money-page-source.mjs";
import { runInNewContext } from "node:vm";

const ID = "5146419622540980737";
const API = "https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/";
const tick = () => new Promise((resolve) => setImmediate(resolve));


function setup(options = {}) {
  NativeWindow.windows = [];
  NativeWindow.onLoad = null;
  NativeWindow.onDrive = null;
  let directCalls = 0;
  let clearCalls = 0;
  let flushCalls = 0;
  const service = createSmartMoneySessionService({
    browserSession: {
      fetch: async () => { directCalls += 1; return new Response("{}", { status: 401 }); },
      clearStorageData: async () => { clearCalls += 1; },
      flushStorageData: () => { flushCalls += 1; },
      cookies: { flushStore: async () => {} },
    },
    BrowserWindow: NativeWindow,
    now: () => 1_788_000_000_000,
    syncTimeoutMs: 40,
    authorizationTimeoutMs: 100,
    driveIntervalMs: 2,
    ...options,
  });
  return { service, counts: () => ({ directCalls, clearCalls, flushCalls }) };
}
const target = { topTraderId: ID, includeLatestRecords: false };

test("登录页加载期间只等待官网请求，不主动探测受保护接口", async () => {
  const { service, counts } = setup();
  const pending = service.authorize(target);
  await tick();
  const window = NativeWindow.current;
  window.url = "https://accounts.binance.com/zh-CN/login";
  window.webContents.emit("did-finish-load");
  await tick();
  const calls = counts().directCalls;
  window.close();
  await pending;
  await service.dispose();
  assert.equal(calls, 0);
});

test("官网先返回401再自动续期成功时，不误判为未登录，并隐藏复用窗口", async () => {
  const { service } = setup();
  NativeWindow.onLoad = (window) => {
    window.respond("positions", { success: false, code: "100002002" }, { status: 401 });
    window.respond("positions", { success: true, data: { data: [] } });
  };
  const pending = service.authorize(target);
  const close = setTimeout(() => NativeWindow.current.close(), 150);
  const result = await pending;
  clearTimeout(close);
  try {
    assert.equal(result.completed, true);
    assert.equal(NativeWindow.current.destroyed, false);
    assert.equal(NativeWindow.current.visible, false);
    assert.equal((await service.syncLatestRecords(target)).authorizationRequired, false);
    assert.equal(NativeWindow.windows.length, 1);
  } finally { await service.dispose(); }
});

test("正常退出保留本机设备会话，只有明确退出登录才清除", async () => {
  const { service, counts } = setup();
  await service.dispose();
  assert.equal(counts().clearCalls, 0);
  assert.equal(counts().flushCalls, 1);
});

test("桌面登录使用固定持久化分区", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /fromPartition\("persist:cryptoreview-binance-smart-money"\)/);
});

test("只接受目标主页的 U 本位固定接口和有限页数", () => {
  const url = `${API}query-positions?topTraderId=${ID}&marketType=UM&page=1&rows=9`;
  assert.deepEqual(parseSmartMoneyRequest(url, ID), { kind: "positions", page: 1, rows: 9 });
  for (const input of [url.replace("https:", "http:"), url.replace("www.binance.com", "evil.example"),
    url.replace(ID, "1111111111111111111"), url.replace("UM", "CM"), url.replace("page=1", "page=101"),
    url.replace("rows=9", "rows=1000"), url.replace("query-positions", "withdraw"),
    url.replace("www.binance.com", "secret@www.binance.com")]) {
    assert.equal(parseSmartMoneyRequest(input, ID), null);
  }
});

test("只点击官网读取标签与分页，不修改请求或访问登录存储", () => {
  let tabs = 0;
  let expands = 0;
  const document = {
    getElementById: () => ({ click: () => { tabs += 1; } }),
    querySelectorAll: () => [
      { textContent: "买入", disabled: false, getClientRects: () => [1], click: () => assert.fail("不应操作交易按钮") },
      { textContent: "展开", disabled: false, getClientRects: () => [1], click: () => { expands += 1; } },
    ],
  };
  runInNewContext(createSmartMoneyPageAction("order-history", 1), { document });
  runInNewContext(createSmartMoneyPageAction("order-history", 2), { document });
  assert.equal(tabs, 2);
  assert.equal(expands, 1);
});

test("成功 HTTP 状态但业务错误或数据结构缺失时不得保存空同步", async () => {
  for (const payload of [{ code: "SYNTHETIC_DENIAL" }, { success: true, data: null }]) {
    const { service } = setup();
    NativeWindow.onLoad = window => window.respond("positions", payload);
    try { await assert.rejects(service.syncLatestRecords(target), /无效数据|数据结构已变化/); }
    finally { await service.dispose(); }
  }
});

test("权限拒绝和限流显示真实错误，保留登录窗口及会话", async () => {
  for (const status of [403, 429]) {
    const { service, counts } = setup();
    NativeWindow.onLoad = window => window.respond("positions", {}, { status });
    await assert.rejects(service.authorize(target), status === 403 ? /拒绝数据访问/ : /请求过于频繁/);
    assert.equal(NativeWindow.current.destroyed, false);
    assert.equal(counts().clearCalls, 0);
    await service.dispose();
  }
});

test("非白名单响应和其它主页不会被读取或导入", async () => {
  const { service } = setup();
  NativeWindow.onLoad = window => {
    window.respond("positions", { secret: "SYNTHETIC_PRIVATE_VALUE" }, { origin: "https://evil.example/" });
    window.respond("positions", { secret: "SYNTHETIC_PRIVATE_VALUE" }, { id: "1111111111111111111" });
    window.respond("positions", { success: true, data: [] }, { requestId: "allowed-response" });
  };
  const result = await service.syncLatestRecords(target);
  assert.equal(result.authorizationRequired, false);
  assert.deepEqual(NativeWindow.current.bodyReads, ["allowed-response"]);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_VALUE/);
  await service.dispose();
});

test("明确退出登录清除本机会话，并取消进行中的同步", async () => {
  const { service, counts } = setup();
  const pending = service.authorize(target);
  await tick();
  assert.deepEqual(await service.logout(), { cleared: true });
  assert.deepEqual(await pending, { completed: false });
  assert.equal(counts().clearCalls, 1);
  await service.dispose();
});

test("超大响应拒绝导入，不返回原始响应或账户字段", async () => {
  const { service } = setup();
  NativeWindow.onLoad = window => window.respond("positions", { success: true, data: "x".repeat(5 * 1024 * 1024) });
  await assert.rejects(service.syncLatestRecords(target), /数据读取失败/);
  await service.dispose();
});

test("业务未登录响应也等待官网恢复，不在等待期间点击接口标签", async () => {
  const { service } = setup();
  let driveCalls = 0;
  NativeWindow.onDrive = () => { driveCalls += 1; return { acted: false }; };
  NativeWindow.onLoad = async window => {
    window.respond("positions", { success: false, code: "100001005", message: "请登录" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(driveCalls, 0);
    window.respond("positions", { success: true, data: [] });
  };
  assert.equal((await service.authorize(target)).syncResult.authorizationRequired, false);
  await service.dispose();
});

test("前一页401已经恢复后，分页超时不会沿用旧错误判成未登录", async () => {
  const { service } = setup();
  NativeWindow.onLoad = window => {
    window.respond("positions", {}, { status: 401 });
    window.respond("positions", { success: true, data: [] });
  };
  await assert.rejects(service.syncLatestRecords({ topTraderId: ID }), /尚未返回完整数据/);
  await service.dispose();
});

test("同一主页重复请求共用一次读取，不同主页并发请求会被拒绝", async () => {
  const { service } = setup();
  NativeWindow.onLoad = async window => {
    await new Promise(resolve => setTimeout(resolve, 10));
    window.respond("positions", { success: true, data: [] });
  };
  const first = service.syncLatestRecords(target);
  const second = service.syncLatestRecords(target);
  assert.equal(first, second);
  await assert.rejects(service.syncLatestRecords({ ...target, topTraderId: "1111111111111111111" }), /正在同步/);
  assert.equal((await first).authorizationRequired, false);
  assert.equal(NativeWindow.windows.length, 1);
  await service.dispose();
});
