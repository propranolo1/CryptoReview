import assert from "node:assert/strict";
import test from "node:test";
import { createReplayHistoryLoader, shiftReplayHistoryRange } from "../lib/replay-history.mjs";

const candle = (time) => ({ time, open: 10, high: 12, low: 9, close: 11, volume: 20, closeTime: time * 1000 + 299999 });
const response = (candles) => ({ ok: true, json: async () => ({ symbol: "BTCUSDT", interval: "5m", candles }) });
const options = { symbol: "BTCUSDT", interval: "5m", market: "binance-futures" };

test("向左补历史以最早开盘前一毫秒为边界，多次拖动持续扩展且没有总根数上限", async () => {
  const requests = [];
  const loader = createReplayHistoryLoader({ ...options, fetchImpl: async (url) => {
    const query = new URL(url, "http://localhost").searchParams;
    requests.push(query);
    const before = (Number(query.get("endTime")) + 1) / 1000;
    return response(Array.from({ length: 1000 }, (_, index) => candle(before - (1000 - index) * 300)));
  } });
  let candles = [candle(10000000), candle(10000300)];
  for (let index = 0; index < 5; index += 1) {
    const result = await loader.load(candles, 1500);
    assert.equal(result.addedCount, 1000);
    assert.equal(result.exhausted, false);
    assert.equal(result.candles.at(-1), candles.at(-1));
    candles = result.candles;
  }
  assert.equal(candles.length, 5002);
  assert.equal(requests[0].get("startTime"), null);
  assert.equal(requests[0].get("endTime"), "9999999999");
  assert.equal(requests[0].get("limit"), "1000");
  assert.equal(requests[0].get("market"), "binance-futures");
  assert.equal(requests[1].get("endTime"), "9699999999");
});

test("历史分页乱序和重复会去重，边界与未来数据不覆盖已载入行情", async () => {
  const candles = [candle(1000), candle(1300)];
  const loader = createReplayHistoryLoader({ ...options, fetchImpl: async () => response([
    candle(700), candle(400), candle(700), { ...candle(1000), close: 10 }, candle(1600),
  ]) });
  const result = await loader.load(candles);
  assert.deepEqual(result.candles.map((item) => item.time), [400, 700, 1000, 1300]);
  assert.equal(result.candles[2], candles[0]);
  assert.equal(result.addedCount, 2);
  assert.equal(result.exhausted, false, "短页也允许继续拖动请求");
});

test("并发拖动只请求一次，空页到达历史起点后不再请求", async () => {
  let resolve;
  let calls = 0;
  const loader = createReplayHistoryLoader({ ...options, fetchImpl: () => {
    calls += 1;
    return new Promise((done) => { resolve = done; });
  } });
  const candles = [candle(1000)];
  const first = loader.load(candles);
  assert.equal(await loader.load(candles), null);
  resolve(response([]));
  assert.equal((await first).exhausted, true);
  assert.equal(await loader.load(candles), null);
  assert.equal(calls, 1);
});

test("请求失败可重试，取消后即使旧响应到达也不返回可合并数据", async () => {
  let calls = 0;
  const loader = createReplayHistoryLoader({ ...options, fetchImpl: async () => {
    if (++calls === 1) return { ok: false, json: async () => ({ message: "网络失败" }) };
    return response([candle(700)]);
  } });
  await assert.rejects(loader.load([candle(1000)]), /网络失败/);
  assert.equal((await loader.load([candle(1000)])).addedCount, 1);
  let resolve;
  let signal;
  const stale = createReplayHistoryLoader({ ...options, fetchImpl: (_url, init) => {
    signal = init.signal;
    return new Promise((done) => { resolve = done; });
  } });
  const pending = stale.load([candle(1000)]);
  stale.cancel();
  assert.equal(signal.aborted, true);
  resolve(response([candle(700)]));
  assert.equal(await pending, null);
});

test("异常行情不能被当作没有更早历史，原数据保持不变", async () => {
  for (const payload of [
    { symbol: "ETHUSDT", interval: "5m", candles: [] },
    { symbol: "BTCUSDT", interval: "1h", candles: [] },
    { symbol: "BTCUSDT", interval: "5m", candles: [candle(1000)] },
    { symbol: "BTCUSDT", interval: "5m", candles: [{ ...candle(700), high: 1 }] },
  ]) {
    const loader = createReplayHistoryLoader({ ...options, fetchImpl: async () => ({ ok: true, json: async () => payload }) });
    await assert.rejects(loader.load([candle(1000)]));
  }
});

test("前插历史后保留视口内同一根 K 线及缩放比例", () => {
  const range = { from: -4.5, to: 80.25 };
  assert.deepEqual(shiftReplayHistoryRange(range, 1000), { from: 995.5, to: 1080.25 });
  assert.equal(shiftReplayHistoryRange(null, 1000), null);
});
