import assert from "node:assert/strict";
import test from "node:test";

import {
  INCREMENTAL_SYNC_OVERLAP_MS,
  resolveExchangeSyncRange,
  selectActiveBinanceOrders,
} from "../lib/exchange-sync.mjs";

test("快速更新从上次成功时间前保留重叠区间，手动同步仍使用完整日期范围", () => {
  const requestedStartTime = Date.parse("2026-07-01T00:00:00.000Z");
  const lastSyncedAt = Date.parse("2026-07-20T12:00:00.000Z");
  const endTime = Date.parse("2026-07-21T12:00:00.000Z");

  assert.deepEqual(
    resolveExchangeSyncRange({
      startTime: requestedStartTime,
      endTime,
      incremental: true,
      lastSyncedAt,
    }),
    {
      requestedStartTime,
      startTime: lastSyncedAt - INCREMENTAL_SYNC_OVERLAP_MS,
      endTime,
      incremental: true,
    },
  );
  assert.deepEqual(
    resolveExchangeSyncRange({
      startTime: requestedStartTime,
      endTime,
      incremental: false,
      lastSyncedAt,
    }),
    {
      requestedStartTime,
      startTime: requestedStartTime,
      endTime,
      incremental: false,
    },
  );
});

test("增量范围不会早于用户选择范围，首次同步不会错误启用增量", () => {
  const startTime = Date.parse("2026-07-20T00:00:00.000Z");
  const endTime = Date.parse("2026-07-21T00:00:00.000Z");

  assert.equal(
    resolveExchangeSyncRange({
      startTime,
      endTime,
      incremental: true,
      lastSyncedAt: startTime + 60_000,
    }).startTime,
    startTime,
  );
  assert.equal(
    resolveExchangeSyncRange({
      startTime,
      endTime,
      incremental: true,
      lastSyncedAt: null,
    }).incremental,
    false,
  );
});

test("活动订单补查只选择当前 Binance 账户且排除终态、OKX 与历史档案", () => {
  const base = {
    userId: "binance-account",
    symbol: "BTCUSDT",
    orderId: "100",
    sourceKind: "api-normal",
    status: "NEW",
  };
  const selected = selectActiveBinanceOrders([
    base,
    { ...base },
    { ...base, orderId: "101", status: "FILLED" },
    { ...base, orderId: "102", userId: "old-account" },
    {
      ...base,
      orderId: "okx-order",
      sourceKind: "okx-api-normal",
      exchangeProvider: "okx-swap",
    },
    {
      ...base,
      orderId: "algo:300",
      sourceKind: "api-algo",
      status: "NEW",
    },
    {
      ...base,
      orderId: "csv-order",
      sourceKind: undefined,
      status: "NEW",
    },
  ], "binance-account");

  assert.deepEqual(selected, [
    { symbol: "BTCUSDT", orderId: "100", kind: "normal" },
    { symbol: "BTCUSDT", orderId: "300", kind: "algo" },
  ]);
});
