import assert from "node:assert/strict";
import test from "node:test";
import { createAssetIconLoader } from "../lib/asset-icon-client.mjs";

const src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const result = (token) => new Response(JSON.stringify({ token, src }));

test("同币不同交易对与合约别名共用图片，请求仅含币种而无订单信息", async () => {
  const requests = [];
  const loader = createAssetIconLoader({ fetchImpl: async (url) => {
    requests.push(url); return result(new URL(url, "http://localhost").searchParams.get("token"));
  } });
  assert.deepEqual(await Promise.all([loader.load("BTCUSDT"), loader.load("BTCUSDC")]), [src, src]);
  assert.deepEqual(await Promise.all([loader.load("1000PEPEUSDT"), loader.load("PEPEUSDT")]), [src, src]);
  assert.deepEqual(requests, ["/api/assets/icon?token=BTC", "/api/assets/icon?token=PEPE"]);
  assert.equal(await loader.load("BTC&url=evil"), null);
});

test("图标队列限制下载并发，失败缓存到期后允许重试", async () => {
  const releases = [];
  let active = 0, peak = 0, current = 1000;
  const loader = createAssetIconLoader({ maxConcurrent: 2, now: () => current, fetchImpl: () => {
    active++; peak = Math.max(peak, active);
    return new Promise((resolve) => releases.push(() => { active--; resolve(new Response(null, { status: 404 })); }));
  } });
  const pending = [loader.load("BTCUSDT"), loader.load("ETHUSDT"), loader.load("SOLUSDT")];
  await Promise.resolve();
  assert.equal(active, 2);
  releases.shift()(); releases.shift()();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  releases.shift()();
  assert.deepEqual(await Promise.all(pending), [null, null, null]);
  assert.equal(peak, 2);
  assert.equal(await loader.load("BTCUSDT"), null);
  current += 61_000;
  const retry = loader.load("BTCUSDT");
  await Promise.resolve(); releases.shift()();
  assert.equal(await retry, null);
});

test("客户端拒绝错币种与外部图片地址，浏览器解码失败后暂时退回字母", async () => {
  for (const payload of [{ token: "ETH", src }, { token: "BTC", src: "https://evil.test/a.png" }]) {
    const loader = createAssetIconLoader({ fetchImpl: async () => new Response(JSON.stringify(payload)) });
    assert.equal(await loader.load("BTCUSDT"), null);
  }
  let requests = 0;
  const loader = createAssetIconLoader({ fetchImpl: async () => { requests++; return result("BTC"); } });
  assert.equal(await loader.load("BTCUSDT"), src);
  loader.reportFailure("BTCUSDT", src);
  assert.equal(await loader.load("BTCUSDT"), null);
  assert.equal(requests, 1);
});
