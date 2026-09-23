import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const config = require("../forge.config.cjs");
const fixtureScript = fileURLToPath(new URL("./fixtures/squirrel-executable.ps1", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };
const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

async function fixture(t, mode = "changed") {
  const directory = await mkdtemp(path.join(tmpdir(), "cryptoreview-exe-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixtureScript, "-Directory", directory, "-Action", "create", "-Mode", mode], { windowsHide: true });
  const lines = [];
  const artifacts = [];
  for (const [kind, name] of Object.entries({
    base: "CryptoReview-0.2.21-full.nupkg", full: "CryptoReview-0.2.22-full.nupkg", delta: "CryptoReview-0.2.22-delta.nupkg",
  })) {
    const file = path.join(directory, name);
    await rename(path.join(directory, `${kind}.nupkg`), file);
    const bytes = await readFile(file);
    lines.push(`${sha1(bytes)} ${name} ${bytes.length}`);
    if (kind !== "base") artifacts.push(file);
  }
  await writeFile(path.join(directory, "RELEASES"), lines.join("\n"));
  artifacts.push(path.join(directory, "RELEASES"));
  return { directory, result: { platform: "win32", arch: "x64", packageJSON: { version: "0.2.22" }, artifacts } };
}

async function inspect(directory) {
  const file = path.join(directory, "CryptoReview-0.2.22-delta.nupkg");
  await rename(file, path.join(directory, "delta.nupkg"));
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixtureScript, "-Directory", directory, "-Action", "inspect"], { windowsHide: true });
    return JSON.parse(stdout.replace(/^\uFEFF/, ""));
  } finally { await rename(path.join(directory, "delta.nupkg"), file); }
}

test("主程序整文件回退必须替换成可还原的小补丁，并更新清单校验", windowsOnly, async (t) => {
  const { directory, result } = await fixture(t);
  const fullPath = path.join(directory, "CryptoReview-0.2.22-full.nupkg");
  const fullBefore = sha1(await readFile(fullPath));
  await config.hooks.postMake(config, [result]);
  const entries = await inspect(directory);
  assert.ok(!entries.some((entry) => entry.name === "lib/net45/CryptoReview.exe"), "不能继续携带完整主程序");
  assert.ok(entries.some((entry) => entry.name === "lib/net45/CryptoReview.exe.bsdiff"));
  assert.ok(entries.some((entry) => entry.name === "lib/net45/CryptoReview.exe.shasum"));
  assert.ok(entries.some((entry) => entry.name === "lib/net45/resources/app.asar"));
  const deltaPath = path.join(directory, "CryptoReview-0.2.22-delta.nupkg");
  const bytes = await readFile(deltaPath);
  assert.ok(bytes.length < 32_000, `稀疏改动补丁不应达到 ${bytes.length} 字节`);
  const manifest = await readFile(path.join(directory, "RELEASES"), "utf8");
  assert.ok(manifest.includes(`${sha1(bytes)} https://github.com/propranolo1/CryptoReview/releases/download/v0.2.22/CryptoReview-0.2.22-delta.nupkg ${bytes.length}`));
  assert.equal(sha1(await readFile(fullPath)), fullBefore);
  await config.hooks.postMake(config, [result]);
  assert.equal(sha1(await readFile(deltaPath)), sha1(bytes), "重复处理不能修改补丁");
});

test("长度增长和缩短的主程序都能生成由原 Squirrel 解码器验证的补丁", windowsOnly, async (t) => {
  for (const mode of ["append", "truncate"]) {
    const { directory, result } = await fixture(t, mode);
    await config.hooks.postMake(config, [result]);
    assert.ok((await stat(path.join(directory, "CryptoReview-0.2.22-delta.nupkg"))).size < 32_000);
  }
});

test("原版 Squirrel 必须接受补丁校验文件并正确还原完整安装包", windowsOnly, async (t) => {
  const { directory, result } = await fixture(t);
  await config.hooks.postMake(config, [result]);
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixtureScript, "-Directory", directory, "-Action", "apply"], { windowsHide: true });
  assert.equal(JSON.parse(stdout.replace(/^\uFEFF/, "")).restored, true);
});

test("主程序大面积变化时保留更小的完整文件回退", windowsOnly, async (t) => {
  const { directory, result } = await fixture(t, "different");
  const deltaPath = path.join(directory, "CryptoReview-0.2.22-delta.nupkg");
  const before = sha1(await readFile(deltaPath));
  await config.hooks.postMake(config, [result]);
  assert.equal(sha1(await readFile(deltaPath)), before);
});

test("旧基准包校验失败时中止发布并保留原始差分包", windowsOnly, async (t) => {
  const { directory, result } = await fixture(t);
  const deltaPath = path.join(directory, "CryptoReview-0.2.22-delta.nupkg");
  const before = sha1(await readFile(deltaPath));
  await writeFile(path.join(directory, "CryptoReview-0.2.21-full.nupkg"), "损坏的测试基准包");
  await assert.rejects(() => config.hooks.postMake(config, [result]), /校验/);
  assert.equal(sha1(await readFile(deltaPath)), before);
});

test("已有差分条目时不重写包内容", windowsOnly, async (t) => {
  const { directory, result } = await fixture(t, "already-patched");
  const deltaPath = path.join(directory, "CryptoReview-0.2.22-delta.nupkg");
  const before = sha1(await readFile(deltaPath));
  await config.hooks.postMake(config, [result]);
  assert.equal(sha1(await readFile(deltaPath)), before);
});
