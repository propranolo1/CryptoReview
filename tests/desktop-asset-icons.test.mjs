import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDiskAssetIconCache } from "../desktop/asset-icon-cache.mjs";
import { startLocalServer } from "../desktop/local-server.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const record = (token) => ({ token, src: `data:image/png;base64,${png}`, updatedAt: Date.now() });
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cryptoreview-icon-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("图片缓存跨实例恢复，中文币种使用安全文件名且拒绝任意路径", async (t) => {
  const root = await directory(t), cache = createDiskAssetIconCache(root);
  const saved = record("牛来");
  await cache.writeCache(saved);
  assert.deepEqual(await createDiskAssetIconCache(root).readCache("牛来"), saved);
  assert.match((await readdir(root))[0], /^[0-9a-f]+\.json$/);
  assert.equal(await cache.readCache("../BTC"), null);
  await assert.rejects(cache.writeCache(record("../BTC")));
  assert.equal((await readdir(root)).length, 1);
});

test("损坏、错币种与超大缓存会被忽略，缓存数量有上限", async (t) => {
  const root = await directory(t), cache = createDiskAssetIconCache(root, { maxEntries: 2 });
  const file = path.join(root, "425443.json");
  await writeFile(file, "{broken"); assert.equal(await cache.readCache("BTC"), null);
  await writeFile(file, JSON.stringify(record("ETH"))); assert.equal(await cache.readCache("BTC"), null);
  await writeFile(file, " ".repeat(400_001)); assert.equal(await cache.readCache("BTC"), null);
  await Promise.all([cache.writeCache(record("BTC")), cache.writeCache(record("ETH")), cache.writeCache(record("SOL"))]);
  assert.equal((await readdir(root)).length, 2);
});

test("桌面固定图标路由合并请求、保存图片且重新启动断网后仍可读取", async (t) => {
  const root = await directory(t), requests = [];
  const logo = "https://bin.bnbstatic.com/image/admin_mgs_image_upload/test/btc.png";
  const server = await startLocalServer({ assetIconCacheDirectory: root, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return url.includes("get-all-asset") ? Response.json({ code: "000000", success: true, data: [{ assetCode: "BTC", logoUrl: logo }] }) :
      new Response(Buffer.from(png, "base64"), { headers: { "Content-Type": "image/png" } });
  } });
  const [first, second] = await Promise.all([fetch(`${server.origin}/api/assets/icon?token=BTC`), fetch(`${server.origin}/api/assets/icon?token=BTC`)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const payload = await first.json();
  assert.deepEqual(payload, { token: "BTC", src: record("BTC").src });
  assert.equal(requests.length, 2);
  assert.ok(first.headers.get("cache-control").includes("private"));
  const invalid = await fetch(`${server.origin}/api/assets/icon?token=..%2FBTC&url=https://evil.test`);
  assert.equal(invalid.status, 400);
  assert.equal(requests.length, 2);
  await server.close();
  const restarted = await startLocalServer({ assetIconCacheDirectory: root, fetchImpl: async () => { throw new Error("断网"); } });
  t.after(restarted.close);
  assert.deepEqual(await (await fetch(`${restarted.origin}/api/assets/icon?token=BTC`)).json(), payload);
  const files = await readdir(root);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, files[0]), "utf8")).token, "BTC");
});

test("桌面图标失败返回无缓存响应，写入失败也不阻断页面", async (t) => {
  const server = await startLocalServer({ fetchImpl: async () => { throw new Error("离线"); } });
  t.after(server.close);
  const response = await fetch(`${server.origin}/api/assets/icon?token=UNKNOWN`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { token: "UNKNOWN", src: null });
  assert.equal((await fetch(`${server.origin}/api/assets/icon?token=BTC`, { method: "POST" })).status, 405);
});
