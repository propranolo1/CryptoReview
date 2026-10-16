import assert from "node:assert/strict";
import test from "node:test";
import { createBinanceUsdmClient } from "../desktop/binance-usdm-client.mjs";

const now = Date.parse("2026-10-10T03:00:00Z");
async function sync(amendmentResponse, knownOrders = []) {
  const requests = [];
  const client = createBinanceUsdmClient({ now: () => now, fetchImpl: async (input, init) => {
    const url = new URL(input); requests.push({ path: url.pathname, method: init?.method, params: url.searchParams });
    if (url.pathname === "/fapi/v1/time") return Response.json({ serverTime: now });
    if (url.pathname === "/fapi/v1/allOrders") return Response.json([{ symbol: "BTCUSDT", orderId: 101,
      side: "BUY", origType: "LIMIT", origQty: "2", executedQty: "2", cumQuote: "200", price: "100",
      avgPrice: "100", status: "FILLED", time: now - 7200_000, updateTime: now - 1000 }]);
    if (url.pathname === "/fapi/v1/userTrades") return Response.json([{ id: 1, orderId: 101, symbol: "BTCUSDT",
      side: "BUY", positionSide: "LONG", qty: "2", price: "100", quoteQty: "200", commission: "0",
      commissionAsset: "USDT", realizedPnl: "0", time: now - 1000, maker: true }]);
    if (url.pathname === "/fapi/v1/orderAmendment") return amendmentResponse();
    return Response.json([]);
  } });
  const result = await client.syncOrders({ apiKey: "synthetic-key", apiSecret: "synthetic-secret",
    accountId: "synthetic-account", knownOrders, symbols: ["BTCUSDT"], startTime: now - 86400_000, endTime: now });
  return { result, requests };
}
const amendment = (overrides = {}) => ({ amendmentId: 7, symbol: "BTCUSDT", orderId: 101, time: now - 7000,
  amendment: { price: { before: "99", after: "100" }, count: 1 }, ...overrides });

test("Binance 用签名 GET 补查真实改单时间与前后价格，沿用只读同步结果", async () => {
  const { result, requests } = await sync(() => Response.json([amendment()]));
  const request = requests.find(item => item.path === "/fapi/v1/orderAmendment");
  assert.ok(request); assert.equal(request.method, "GET");
  assert.equal(request.params.get("orderId"), "101"); assert.equal(request.params.get("symbol"), "BTCUSDT");
  assert.ok(request.params.has("signature"));
  assert.deepEqual(result.orders[0].amendmentHistory, { status: "complete", checkedAt: new Date(now).toISOString(),
    changes: [{ amendmentId: "7", time: new Date(now - 7000).toISOString(), beforePrice: 99, afterPrice: 100 }] });
  assert.equal(result.fillCount, 1); assert.equal(result.orders[0].executedQuantity, 2);
});

test("改单端点失败不破坏既有同步，也不能当作从未修改", async () => {
  const { result } = await sync(() => Response.json({ code: -1000, msg: "synthetic failure" }, { status: 500 }));
  assert.equal(result.orders[0].amendmentHistory.status, "unavailable");
  assert.equal(result.orders[0].fills.length, 1);
});

test("改单返回截断或身份不匹配不能冒充完整历史", async () => {
  const { result } = await sync(() => Response.json([amendment({ amendment: { price: { before: "99", after: "100" }, count: 2 } })]));
  assert.equal(result.orders[0].amendmentHistory.status, "partial");
  const mismatched = await sync(() => Response.json([amendment({ orderId: 102 })]));
  assert.equal(mismatched.result.orders[0].amendmentHistory.status, "unavailable");
});

test("已成交且状态未变化的完整改单证据直接复用，不重复增加快速更新请求", async () => {
  const first = await sync(() => Response.json([amendment()]));
  const next = await sync(() => { throw new Error("不应重复请求"); }, first.result.orders);
  assert.equal(next.requests.some(item => item.path === "/fapi/v1/orderAmendment"), false);
  assert.deepEqual(next.result.orders[0].amendmentHistory, first.result.orders[0].amendmentHistory);
  const other = first.result.orders.map(item => ({ ...item, userId: "another-account" }));
  const isolated = await sync(() => Response.json([]), other);
  assert.ok(isolated.requests.some(item => item.path === "/fapi/v1/orderAmendment"));
});
