import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildUpdateFeedUrl,
  compareVersions,
  createUpdateService,
} from "../desktop/update-service.mjs";

test("版本号比较忽略 v 前缀并按语义版本排序", () => {
  assert.equal(compareVersions("v0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.2.1"), -1);
});

test("更新地址固定指向公开 GitHub 仓库和当前平台架构", () => {
  assert.equal(
    buildUpdateFeedUrl({
      owner: "propranolo1",
      repo: "CryptoReview",
      platform: "win32",
      arch: "x64",
      version: "0.2.0",
    }),
    "https://update.electronjs.org/propranolo1/CryptoReview/win32-x64/0.2.0",
  );
});

test("发现新版本后启动 Squirrel 下载并在完成后允许重启安装", async () => {
  const autoUpdater = new EventEmitter();
  const calls = [];
  autoUpdater.setFeedURL = (options) => calls.push(["feed", options]);
  autoUpdater.checkForUpdates = async () => calls.push(["check"]);
  autoUpdater.quitAndInstall = () => calls.push(["install"]);

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0", isPackaged: true },
    autoUpdater,
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v0.2.1",
      html_url: "https://github.com/propranolo1/CryptoReview/releases/tag/v0.2.1",
    }), { status: 200 }),
    owner: "propranolo1",
    repo: "CryptoReview",
    platform: "win32",
    arch: "x64",
  });

  const checking = await service.check({ manual: true });
  assert.equal(checking.available, true);
  assert.equal(checking.latestVersion, "0.2.1");
  assert.equal(checking.state, "downloading");
  assert.deepEqual(calls, [
    ["feed", {
      url: "https://update.electronjs.org/propranolo1/CryptoReview/win32-x64/0.2.0",
    }],
    ["check"],
  ]);

  autoUpdater.emit("update-downloaded", {}, "v0.2.1");
  assert.equal(service.getStatus().state, "downloaded");
  assert.equal(service.getStatus().canInstall, true);

  await service.install();
  assert.deepEqual(calls.at(-1), ["install"]);
  service.dispose();
});

test("未打包环境只检测版本，不调用自动安装器", async () => {
  const autoUpdater = new EventEmitter();
  let updaterCalled = false;
  autoUpdater.setFeedURL = () => { updaterCalled = true; };
  autoUpdater.checkForUpdates = async () => { updaterCalled = true; };

  const service = createUpdateService({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    autoUpdater,
    fetchImpl: async () => new Response(JSON.stringify({
      tag_name: "v0.3.0",
      html_url: "https://github.com/propranolo1/CryptoReview/releases/tag/v0.3.0",
    }), { status: 200 }),
    owner: "propranolo1",
    repo: "CryptoReview",
    platform: "win32",
    arch: "x64",
  });

  const status = await service.check({ manual: true });
  assert.equal(status.state, "available");
  assert.equal(status.canAutoUpdate, false);
  assert.equal(updaterCalled, false);
  service.dispose();
});
