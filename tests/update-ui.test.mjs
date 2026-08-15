import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("顶部版本按钮通过受限桌面 IPC 检查并安装更新", async () => {
  const [component, tradeReplay, preload, declarations] = await Promise.all([
    readFile(new URL("app/components/AppUpdateControl.tsx", projectUrl), "utf8"),
    readFile(new URL("app/components/TradeReplay.tsx", projectUrl), "utf8"),
    readFile(new URL("desktop/preload.cjs", projectUrl), "utf8"),
    readFile(new URL("app/desktop-api.d.ts", projectUrl), "utf8"),
  ]);

  assert.match(component, /getUpdateStatus/);
  assert.match(component, /checkForUpdates/);
  assert.match(component, /installUpdate/);
  assert.match(component, /openUpdateRelease/);
  assert.match(tradeReplay, /<AppUpdateControl\s*\/>/);
  assert.match(preload, /desktop:update-status/);
  assert.match(preload, /desktop:update-check/);
  assert.match(preload, /desktop:update-install/);
  assert.match(preload, /desktop:update-open-release/);
  assert.match(declarations, /interface DesktopUpdateStatus/);
});

test("版本标签会触发 GitHub Actions 创建桌面 Release", async () => {
  const [workflow, packageSource, packageLockSource, forgeSource] = await Promise.all([
    readFile(new URL(".github/workflows/release.yml", projectUrl), "utf8"),
    readFile(new URL("package.json", projectUrl), "utf8"),
    readFile(new URL("package-lock.json", projectUrl), "utf8"),
    readFile(new URL("forge.config.cjs", projectUrl), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const packageLock = JSON.parse(packageLockSource);

  assert.match(workflow, /tags:\s*\n\s*- ["']v\*/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /desktop:make:win/);
  assert.match(workflow, /gh release create/);
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(packageJson.repository.url, "https://github.com/propranolo1/CryptoReview.git");
  assert.match(forgeSource, /@electron-forge\/maker-squirrel/);
});
