import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const forgeConfig = require("../forge.config.cjs");
const baseUrl = "https://github.com/propranolo1/CryptoReview/releases/download";
const entry = (version, kind, content = "测试安装包", absolute = false) => {
  const file = `CryptoReview-${version}-${kind}.nupkg`;
  const sha = createHash("sha1").update(content).digest("hex");
  return `${sha} ${absolute ? `${baseUrl}/v${version}/` : ""}${file} ${Buffer.byteLength(content)}`;
};

async function makeFixture(manifest, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cryptoreview-delta-test-"));
  const files = {
    RELEASES: manifest,
    "CryptoReview-0.2.22-full.nupkg": "测试安装包",
    "CryptoReview-0.2.22-delta.nupkg": "测试安装包",
    "CryptoReview-0.2.22 Setup.exe": "测试安装器",
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content);
  }
  return {
    directory,
    result: {
      platform: "win32", arch: "x64", packageJSON: { version: "0.2.22" },
      artifacts: Object.keys(files).map((name) => path.join(directory, name)),
    },
  };
}

test("发布清单兼容旧更新服务，并保留跨版本差分链和完整包兜底", async () => {
  const fixture = await makeFixture([
    entry("0.2.20", "full"),
    entry("0.2.21", "delta", undefined, true),
    entry("0.2.21", "full"),
    entry("0.2.22", "delta"),
    entry("0.2.22", "full"),
  ].join("\r\n"));
  const results = await forgeConfig.hooks.postMake(forgeConfig, [fixture.result]);
  const manifest = await readFile(path.join(fixture.directory, "RELEASES"), "utf8");
  assert.equal(manifest, [
    entry("0.2.22", "full"),
    entry("0.2.21", "delta", undefined, true),
    entry("0.2.22", "delta", undefined, true),
    "",
  ].join("\n"));
  assert.deepEqual(results, [fixture.result]);

  // 官方服务只替换第一个包名；首行必须是相对路径，其余包必须已经是绝对地址。
  const servedManifest = manifest.replace("CryptoReview-0.2.22-full.nupkg", `${baseUrl}/v0.2.22/CryptoReview-0.2.22-full.nupkg`);
  const urls = servedManifest.trim().split("\n").map((line) => new URL(line.split(" ")[1]));
  assert.ok(urls.every((url) => url.origin === "https://github.com"));
  assert.equal(urls[1].pathname, "/propranolo1/CryptoReview/releases/download/v0.2.21/CryptoReview-0.2.21-delta.nupkg");
  // 重复执行不会产生双重 URL，也不会丢失差分链。
  await forgeConfig.hooks.postMake(forgeConfig, [fixture.result]);
  assert.equal(await readFile(path.join(fixture.directory, "RELEASES"), "utf8"), manifest);
});

test("差分包缺失时中止发布，防止悄悄退回只发布全量包", async () => {
  const fixture = await makeFixture(entry("0.2.22", "full"));
  await assert.rejects(() => forgeConfig.hooks.postMake(forgeConfig, [fixture.result]), /差分包/);
});

test("缺少完整包时中止发布，保证首次安装和失败回退可用", async () => {
  const fixture = await makeFixture(entry("0.2.22", "delta"));
  await assert.rejects(() => forgeConfig.hooks.postMake(forgeConfig, [fixture.result]), /完整包/);
});

test("当前包的哈希或大小与清单不符时拒绝发布", async () => {
  const fixture = await makeFixture([
    entry("0.2.22", "delta"), entry("0.2.22", "full"),
  ].join("\n"), { "CryptoReview-0.2.22-delta.nupkg": "损坏的差分包" });
  await assert.rejects(() => forgeConfig.hooks.postMake(forgeConfig, [fixture.result]), /校验/);
});

test("错误版本、重复条目和外部包地址不能进入差分清单", async () => {
  for (const extra of [
    entry("0.2.23", "delta"),
    entry("0.2.22", "delta"),
    entry("0.2.21", "delta", undefined, true).replace("github.com", "example.com"),
  ]) {
    const fixture = await makeFixture([
      entry("0.2.22", "full"), entry("0.2.22", "delta"), extra,
    ].join("\n"));
    await assert.rejects(() => forgeConfig.hooks.postMake(forgeConfig, [fixture.result]));
  }
});

test("macOS ZIP 构建不经过 Windows 差分清单处理", async () => {
  const result = { platform: "darwin", arch: "arm64", artifacts: ["CryptoReview.zip"] };
  assert.deepEqual(await forgeConfig.hooks.postMake(forgeConfig, [result]), [result]);
});
