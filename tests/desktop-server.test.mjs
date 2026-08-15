import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { startLocalServer } from "../desktop/local-server.mjs";
import {
  SECURE_WEB_PREFERENCES,
  isAllowedNavigation,
  registerDesktopIpc,
} from "../desktop/main.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function requestRaw(origin, requestPath) {
  const url = new URL(origin);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

test("桌面本地服务提供 vinext 首页与客户端静态资源", async (t) => {
  const server = await startLocalServer({ projectRoot });
  t.after(server.close);

  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const homepage = await fetch(`${server.origin}/`);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await homepage.text(), /CryptoReview|交易复盘/);

  const asset = await fetch(`${server.origin}/favicon.svg`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.deepEqual(
    Buffer.from(await asset.arrayBuffer()),
    await readFile(path.join(projectRoot, "dist", "client", "favicon.svg")),
  );
});

test("桌面本地服务拒绝目录穿越", async (t) => {
  const server = await startLocalServer({ projectRoot });
  t.after(server.close);

  const response = await requestRaw(server.origin, "/..%2Fpackage.json");
  assert.equal(response.status, 400);
  assert.doesNotMatch(response.body.toString("utf8"), /site-creator-vinext-starter/);
});

test("Electron 窗口关闭 Node 能力并只允许本地来源导航", () => {
  assert.deepEqual(SECURE_WEB_PREFERENCES, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  });
  assert.equal(
    isAllowedNavigation(
      "http://127.0.0.1:41821/dashboard",
      "http://127.0.0.1:41821",
    ),
    true,
  );
  assert.equal(
    isAllowedNavigation("https://example.com", "http://127.0.0.1:41821"),
    false,
  );
  assert.equal(isAllowedNavigation("file:///C:/secret", "http://127.0.0.1:41821"), false);
});

test("Electron 主进程只注册约定的存储、交易所 API 与视频导出 IPC", async () => {
  const handlers = new Map();
  const calls = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const repository = {
    loadState() {
      calls.push(["loadState"]);
      return { orders: [], trades: [], trainingResults: [] };
    },
    saveOrders(orders) {
      calls.push(["saveOrders", orders]);
    },
    saveTrades(trades) {
      calls.push(["saveTrades", trades]);
    },
    saveTrainingResults(results) {
      calls.push(["saveTrainingResults", results]);
    },
  };
  const binanceApiService = {
    getStatus() {
      calls.push(["binanceStatus"]);
      return { configured: false };
    },
    configure(credentials) {
      calls.push(["binanceConfigure", credentials]);
      return { configured: true };
    },
    remove() {
      calls.push(["binanceRemove"]);
      return { configured: false };
    },
    syncOrders(options) {
      calls.push(["binanceSync", options]);
      return { orders: [], syncedAt: 1784189000000 };
    },
  };
  const okxApiService = {
    getStatus() {
      calls.push(["okxStatus"]);
      return { configured: false };
    },
    configure(credentials) {
      calls.push(["okxConfigure", credentials]);
      return { configured: true };
    },
    remove() {
      calls.push(["okxRemove"]);
      return { configured: false };
    },
    syncOrders(options) {
      calls.push(["okxSync", options]);
      return { orders: [], syncedAt: 1785300000000 };
    },
  };
  const videoExportService = {
    begin(options) {
      calls.push(["videoBegin", options]);
      return { canceled: false, exportId: "video-1", filePath: "C:/video.mp4" };
    },
    append(input) {
      calls.push(["videoAppend", input]);
      return { exportId: input.exportId, bytesWritten: input.chunk.byteLength };
    },
    complete(exportId) {
      calls.push(["videoComplete", exportId]);
      return { exportId, filePath: "C:/video.mp4", bytesWritten: 2 };
    },
    cancel(exportId) {
      calls.push(["videoCancel", exportId]);
      return { canceled: true, exportId };
    },
  };
  const updateService = {
    getStatus() {
      calls.push(["updateStatus"]);
      return {
        state: "current",
        currentVersion: "0.2.0",
        latestVersion: "0.2.0",
        releaseUrl: "https://github.com/propranolo1/CryptoReview/releases/latest",
      };
    },
    check(options) {
      calls.push(["updateCheck", options]);
      return { state: "checking", currentVersion: "0.2.0" };
    },
    install() {
      calls.push(["updateInstall"]);
      return { state: "installing", currentVersion: "0.2.0" };
    },
  };
  const shell = {
    openExternal(url) {
      calls.push(["openExternal", url]);
    },
  };
  const unregister = registerDesktopIpc({
    ipcMain,
    repository,
    binanceApiService,
    okxApiService,
    videoExportService,
    updateService,
    shell,
    app: { getVersion: () => "0.2.0" },
    databasePath: "C:/data/cryptoreview.db",
    serverOrigin: "http://127.0.0.1:41821",
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    "desktop:binance-api-configure",
    "desktop:binance-api-remove",
    "desktop:binance-api-status",
    "desktop:binance-api-sync-orders",
    "desktop:get-info",
    "desktop:load-state",
    "desktop:okx-api-configure",
    "desktop:okx-api-remove",
    "desktop:okx-api-status",
    "desktop:okx-api-sync-orders",
    "desktop:save-orders",
    "desktop:save-profiles",
    "desktop:save-trades",
    "desktop:save-training-results",
    "desktop:update-check",
    "desktop:update-install",
    "desktop:update-open-release",
    "desktop:update-status",
    "desktop:video-export-append",
    "desktop:video-export-begin",
    "desktop:video-export-cancel",
    "desktop:video-export-complete",
  ]);
  assert.deepEqual(await handlers.get("desktop:load-state")(), {
    orders: [],
    trades: [],
    trainingResults: [],
  });
  await handlers.get("desktop:save-orders")(null, [{ orderId: "1" }]);
  await handlers.get("desktop:save-trades")(null, [{ id: "trade-1" }]);
  await handlers.get("desktop:save-training-results")(null, [{ id: "training-1" }]);
  assert.deepEqual(calls, [
    ["loadState"],
    ["saveOrders", [{ orderId: "1" }]],
    ["saveTrades", [{ id: "trade-1" }]],
    ["saveTrainingResults", [{ id: "training-1" }]],
  ]);
  assert.deepEqual(await handlers.get("desktop:get-info")(), {
    appVersion: "0.2.0",
    databasePath: "C:/data/cryptoreview.db",
    platform: process.platform,
    serverOrigin: "http://127.0.0.1:41821",
    storage: "sqlite",
    version: "0.2.0",
  });
  const trustedEvent = { senderFrame: { url: "http://127.0.0.1:41821/" } };
  assert.equal(
    (await handlers.get("desktop:update-status")(trustedEvent)).state,
    "current",
  );
  assert.deepEqual(
    await handlers.get("desktop:update-check")(trustedEvent),
    { state: "checking", currentVersion: "0.2.0" },
  );
  assert.deepEqual(
    await handlers.get("desktop:update-install")(trustedEvent),
    { state: "installing", currentVersion: "0.2.0" },
  );
  assert.deepEqual(
    await handlers.get("desktop:update-open-release")(trustedEvent),
    {
      opened: true,
      url: "https://github.com/propranolo1/CryptoReview/releases/latest",
    },
  );
  assert.deepEqual(
    await handlers.get("desktop:binance-api-status")(trustedEvent),
    { configured: false },
  );
  assert.deepEqual(
    await handlers.get("desktop:binance-api-configure")(
      trustedEvent,
      { apiKey: "key", apiSecret: "secret" },
    ),
    { configured: true },
  );
  assert.deepEqual(
    await handlers.get("desktop:binance-api-sync-orders")(
      trustedEvent,
      { symbols: ["BTCUSDT"], startTime: 1, endTime: 2 },
    ),
    { orders: [], syncedAt: 1784189000000 },
  );
  assert.deepEqual(
    await handlers.get("desktop:binance-api-remove")(trustedEvent),
    { configured: false },
  );
  assert.deepEqual(
    await handlers.get("desktop:okx-api-status")(trustedEvent),
    { configured: false },
  );
  assert.deepEqual(
    await handlers.get("desktop:okx-api-configure")(
      trustedEvent,
      {
        apiKey: "okx-key",
        apiSecret: "okx-secret",
        passphrase: "okx-passphrase",
        region: "global",
      },
    ),
    { configured: true },
  );
  assert.deepEqual(
    await handlers.get("desktop:okx-api-sync-orders")(
      trustedEvent,
      { startTime: 1, endTime: 2 },
    ),
    { orders: [], syncedAt: 1785300000000 },
  );
  assert.deepEqual(
    await handlers.get("desktop:okx-api-remove")(trustedEvent),
    { configured: false },
  );
  assert.deepEqual(
    await handlers.get("desktop:video-export-begin")(
      trustedEvent,
      { suggestedName: "BTCUSDT.mp4", mimeType: "video/mp4" },
    ),
    { canceled: false, exportId: "video-1", filePath: "C:/video.mp4" },
  );
  assert.deepEqual(
    await handlers.get("desktop:video-export-append")(
      trustedEvent,
      { exportId: "video-1", chunk: Uint8Array.from([1, 2]) },
    ),
    { exportId: "video-1", bytesWritten: 2 },
  );
  assert.deepEqual(
    await handlers.get("desktop:video-export-complete")(trustedEvent, "video-1"),
    { exportId: "video-1", filePath: "C:/video.mp4", bytesWritten: 2 },
  );
  assert.deepEqual(
    await handlers.get("desktop:video-export-cancel")(trustedEvent, "video-1"),
    { canceled: true, exportId: "video-1" },
  );
  await assert.rejects(
    async () => handlers.get("desktop:update-check")({
      senderFrame: { url: "https://evil.example/" },
    }),
    /不受信任/,
  );
  await assert.rejects(
    async () => handlers.get("desktop:binance-api-status")({
      senderFrame: { url: "https://evil.example/" },
    }),
    /不受信任/,
  );
  await assert.rejects(
    async () => handlers.get("desktop:okx-api-status")({
      senderFrame: { url: "https://evil.example/" },
    }),
    /不受信任/,
  );
  await assert.rejects(
    async () => handlers.get("desktop:video-export-begin")(
      { senderFrame: { url: "https://evil.example/" } },
      { suggestedName: "stolen.mp4", mimeType: "video/mp4" },
    ),
    /不受信任/,
  );

  unregister();
  assert.equal(handlers.size, 0);
});
