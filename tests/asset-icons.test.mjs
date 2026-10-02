import assert from "node:assert/strict";
import test from "node:test";
import { createAssetIconService, normalizeIconToken, isValidIconRecord } from "../lib/asset-icons.mjs";

// 合成的 1×1 PNG，用于测试图片边界，不依赖真实交易记录或联网。
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const logo = "https://bin.bnbstatic.com/image/admin_mgs_image_upload/test/btc.png";
const catalog = [{ assetCode: "BTC", logoUrl: logo }, { assetCode: "PEPE", logoUrl: logo }];
const image = () => new Response(Buffer.from(PNG, "base64"), { headers: { "Content-Type": "image/png" } });
const metadata = (rows = catalog) => new Response(JSON.stringify({ code: "000000", success: true, data: rows }));

test("图标仅对明确的合约别名归一化，保留 1INCH、中文币种和原生数字币名", () => {
  assert.equal(normalizeIconToken("1000pepe"), "PEPE");
  assert.equal(normalizeIconToken("1000SHIB"), "SHIB");
  assert.equal(normalizeIconToken("1INCH"), "1INCH");
  assert.equal(normalizeIconToken("1000SATS"), "1000SATS");
  assert.equal(normalizeIconToken("牛来"), "牛来");
  for (const token of ["", "../BTC", "BTC&url=x", "https://example.com", "A".repeat(41)]) {
    assert.equal(normalizeIconToken(token), "");
  }
});

test("相同币种与别名合并请求，不同币种共用一次公开元数据读取", async () => {
  const requests = [];
  const service = createAssetIconService({ fetchImpl: async (url) => {
    requests.push(url);
    return url.includes("get-all-asset") ? metadata() : image();
  } });
  const [btc, duplicate, pepe, alias] = await Promise.all([
    service.getIcon("BTC"), service.getIcon("btc"), service.getIcon("PEPE"), service.getIcon("1000PEPE"),
  ]);
  assert.deepEqual(btc, duplicate);
  assert.deepEqual(pepe, alias);
  assert.equal(requests.filter((url) => url.includes("get-all-asset")).length, 1);
  assert.equal(requests.length, 3);
  assert.equal(btc.src, `data:image/png;base64,${PNG}`);
  assert.ok(isValidIconRecord(btc, "BTC"));
  await service.getIcon("BTC");
  assert.equal(requests.length, 3);
});

test("缓存恢复无需网络，过期图标仍显示且后台更新失败时保留原图片", async () => {
  let current = 1000, requests = 0;
  const record = { token: "BTC", src: `data:image/png;base64,${PNG}`, updatedAt: current };
  const service = createAssetIconService({ now: () => current, readCache: async () => record,
    fetchImpl: async () => { requests++; throw new Error("离线"); } });
  assert.deepEqual(await service.getIcon("BTC"), record);
  assert.equal(requests, 0);
  current += 31 * 86400_000;
  assert.deepEqual(await service.getIcon("BTC"), record);
  await service.settled();
  assert.equal(requests, 1);
  assert.deepEqual(await service.getIcon("BTC"), record);
  assert.equal(requests, 1);
});

test("找不到图标与接口失败有重试间隔，坏缓存不作为有效图片", async () => {
  let current = 1000, requests = 0;
  const service = createAssetIconService({ now: () => current, readCache: async () => ({
    token: "ETH", src: "data:image/svg+xml;base64,PHN2Zy8+", updatedAt: current }),
    fetchImpl: async () => { requests++; throw new Error("网络异常"); } });
  assert.equal(await service.getIcon("BTC"), null);
  assert.equal(await service.getIcon("BTC"), null);
  assert.equal(await service.getIcon("ETH"), null);
  assert.equal(requests, 1, "上游失败不能为每一行重复请求元数据");
  current += 61_000;
  assert.equal(await service.getIcon("BTC"), null);
  assert.equal(requests, 2);
});

test("图标下载仅允许固定 CDN、HTTPS 和无重定向请求，不接受客户端上游地址", async () => {
  for (const invalid of ["http://bin.bnbstatic.com/a.png", "https://bin.bnbstatic.com.evil.test/a.png",
    "https://user:pass@bin.bnbstatic.com/a.png", "https://127.0.0.1/a.png", "https://bin.bnbstatic.com:8443/a.png"]) {
    const requests = [];
    const service = createAssetIconService({ fetchImpl: async (url, init) => {
      requests.push({ url, init }); return metadata([{ assetCode: "BTC", logoUrl: invalid }]);
    } });
    assert.equal(await service.getIcon("BTC"), null);
    assert.equal(requests.length, 1);
  }
  const requests = [];
  const service = createAssetIconService({ fetchImpl: async (url, init) => {
    requests.push({ url, init }); return url.includes("get-all-asset") ? metadata() : image();
  } });
  await service.getIcon("BTC");
  assert.equal(requests[1].init.redirect, "error");
  assert.equal(requests[1].init.credentials, "omit");
  assert.equal(await service.getIcon("https://example.com"), null);
  assert.equal(requests.length, 2);
});

test("HTML、SVG、伪造图片、超大响应和失败响应都不缓存", async () => {
  for (const badImage of [
    () => new Response("<html>错误页</html>", { headers: { "Content-Type": "image/png" } }),
    () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    () => new Response(Buffer.alloc(300_000), { headers: { "Content-Type": "image/png" } }),
    () => new Response(null, { status: 404 }),
  ]) {
    let writes = 0;
    const service = createAssetIconService({ writeCache: async () => { writes++; },
      fetchImpl: async (url) => url.includes("get-all-asset") ? metadata() : badImage() });
    assert.equal(await service.getIcon("BTC"), null);
    assert.equal(writes, 0);
  }
});

test("同名币元数据冲突时不猜测图标，目录失败不当作完整目录", async () => {
  const service = createAssetIconService({ fetchImpl: async () => metadata([
    { assetCode: "BTC", logoUrl: logo }, { assetCode: "BTC", logoUrl: logo.replace("btc", "other") },
  ]) });
  assert.equal(await service.getIcon("BTC"), null);
  const failed = createAssetIconService({ fetchImpl: async () => new Response(JSON.stringify({ success: false, data: catalog })) });
  assert.equal(await failed.getIcon("BTC"), null);
});

test("磁盘写入失败仍能显示图标，内存缓存有数量上限", async () => {
  const service = createAssetIconService({ maxEntries: 1, writeCache: async () => { throw new Error("磁盘只读"); },
    fetchImpl: async (url) => url.includes("get-all-asset") ? metadata() : image() });
  assert.ok(await service.getIcon("BTC"));
  assert.ok(await service.getIcon("PEPE"));
  assert.equal(service.cacheSize, 1);
});

test("冷启动恢复过期图片后立即后台更新，断网时不等待网络即可显示缓存", async () => {
  const current = 40 * 86400_000;
  const record = { token: "BTC", src: `data:image/png;base64,${PNG}`, updatedAt: 1000 };
  let requests = 0, reject;
  const service = createAssetIconService({ now: () => current, readCache: async () => record,
    fetchImpl: async () => { requests++; return new Promise((_, fail) => { reject = fail; }); } });
  assert.deepEqual(await service.getIcon("BTC"), record);
  assert.equal(requests, 1);
  reject(new Error("离线")); await service.settled();
  assert.deepEqual(await service.getIcon("BTC"), record);
  assert.equal(requests, 1);
});

test("目录缺少币种时不下载图片，短期不重复查找，目录到期后能发现新币", async () => {
  let current = 1000, requests = 0;
  const service = createAssetIconService({ now: () => current, fetchImpl: async () => { requests++; return metadata(); } });
  assert.equal(await service.getIcon("UNKNOWN"), null);
  assert.equal(await service.getIcon("UNKNOWN"), null);
  assert.equal(requests, 1);
  current += 6 * 3600_000 + 1;
  assert.equal(await service.getIcon("UNKNOWN"), null);
  assert.equal(requests, 2);
});
