import assert from "node:assert/strict";
import test from "node:test";

import { createBinanceApiService } from "../desktop/binance-api-service.mjs";

test("Binance API 服务先验证再加密保存，并在同步后先落订单再更新时间", async () => {
  const calls = [];
  const vault = {
    getStatus: () => ({ configured: false }),
    save(credentials) {
      calls.push(["save", credentials]);
      return { configured: true, apiKeyHint: "…-key", lastSyncedAt: null };
    },
    read() {
      calls.push(["read"]);
      return { accountId: "account", apiKey: "api-key", apiSecret: "secret" };
    },
    markSynced(value) {
      calls.push(["markSynced", value]);
      return { configured: true, lastSyncedAt: value };
    },
    remove() {
      calls.push(["remove"]);
      return { configured: false };
    },
  };
  const client = {
    async validateCredentials(credentials) {
      calls.push(["validate", credentials]);
      return { accountAlias: "SgsR" };
    },
    async syncOrders(options) {
      calls.push(["sync", options]);
      return {
        orders: [{ userId: "account", symbol: "BTCUSDT", orderId: "1" }],
        symbols: ["BTCUSDT"],
        normalOrderCount: 1,
        algoOrderCount: 0,
        syncedAt: 1784189000000,
      };
    },
  };
  const repository = {
    saveExchangeSyncSnapshot(snapshot) {
      calls.push(["saveExchangeSyncSnapshot", snapshot]);
    },
  };
  const service = createBinanceApiService({ repository, vault, client });

  await service.configure({ apiKey: "api-key", apiSecret: "secret" });
  const result = await service.syncOrders({
    symbols: ["BTCUSDT"],
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(calls.map(([name]) => name), [
    "validate",
    "save",
    "read",
    "sync",
    "saveExchangeSyncSnapshot",
    "markSynced",
  ]);
  assert.equal(result.orders.length, 1);
  assert.equal(result.accountId, "account");
  assert.deepEqual(result.status, { configured: true, lastSyncedAt: 1784189000000 });
  assert.deepEqual(calls.find(([name]) => name === "save")?.[1], {
    apiKey: "api-key",
    apiSecret: "secret",
    accountAlias: "SgsR",
  });
});

test("Binance API 服务在标记同步成功前保存包含空仓的完整同步快照", async () => {
  const calls = [];
  const orders = [{ userId: "account", symbol: "BTCUSDT", orderId: "1" }];
  const service = createBinanceApiService({
    repository: {
      saveOrders() {},
      saveExchangeSyncSnapshot(snapshot) {
        calls.push(["saveExchangeSyncSnapshot", snapshot]);
      },
    },
    vault: {
      read() {
        return { accountId: "account", apiKey: "api-key", apiSecret: "secret" };
      },
      markSynced(syncedAt) {
        calls.push(["markSynced", syncedAt]);
        return { configured: true, lastSyncedAt: syncedAt };
      },
    },
    client: {
      async syncOrders() {
        return {
          orders,
          openPositions: [],
          syncedAt: 1784189000000,
        };
      },
    },
  });

  await service.syncOrders({
    symbols: ["BTCUSDT"],
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(calls, [
    ["saveExchangeSyncSnapshot", {
      provider: "binance-usdm",
      accountId: "account",
      orders,
      openPositions: [],
      syncedAt: 1784189000000,
    }],
    ["markSynced", 1784189000000],
  ]);
});

test("Binance 同步快照保存失败时不得标记同步成功", async () => {
  let markSyncedCalled = false;
  const service = createBinanceApiService({
    repository: {
      saveOrders() {},
      saveExchangeSyncSnapshot() {
        throw new Error("同步快照写入失败");
      },
    },
    vault: {
      read() {
        return { accountId: "account", apiKey: "api-key", apiSecret: "secret" };
      },
      markSynced() {
        markSyncedCalled = true;
        return { configured: true };
      },
    },
    client: {
      async syncOrders() {
        return {
          orders: [{ userId: "account", symbol: "BTCUSDT", orderId: "1" }],
          openPositions: [],
          syncedAt: 1784189000000,
        };
      },
    },
  });

  await assert.rejects(
    service.syncOrders({
      symbols: ["BTCUSDT"],
      startTime: 1784102400000,
      endTime: 1784188799000,
    }),
    /同步快照写入失败/,
  );
  assert.equal(markSyncedCalled, false);
});

test("Binance 快速更新使用增量范围并只补查当前账户活动订单", async () => {
  const requestedStartTime = Date.parse("2026-07-01T00:00:00.000Z");
  const lastSyncedAt = Date.parse("2026-07-20T12:00:00.000Z");
  const endTime = Date.parse("2026-07-21T12:00:00.000Z");
  let clientOptions;
  const service = createBinanceApiService({
    repository: {
      loadState() {
        return {
          orders: [
            {
              userId: "account",
              symbol: "BTCUSDT",
              orderId: "100",
              sourceKind: "api-normal",
              status: "NEW",
            },
            {
              userId: "other-account",
              symbol: "STALEUSDT",
              orderId: "200",
              sourceKind: "api-normal",
              status: "NEW",
            },
          ],
        };
      },
      saveExchangeSyncSnapshot() {},
    },
    vault: {
      getStatus() {
        return { configured: true, lastSyncedAt };
      },
      read() {
        return { accountId: "account", apiKey: "key", apiSecret: "secret" };
      },
      markSynced(syncedAt) {
        return { configured: true, lastSyncedAt: syncedAt };
      },
    },
    client: {
      async syncOrders(options) {
        clientOptions = options;
        return {
          orders: [],
          openPositions: [],
          symbols: [],
          syncedAt: endTime,
        };
      },
    },
  });

  const result = await service.syncOrders({
    startTime: requestedStartTime,
    endTime,
    incremental: true,
  });

  assert.equal(clientOptions.startTime > requestedStartTime, true);
  assert.deepEqual(clientOptions.knownActiveOrders, [
    { symbol: "BTCUSDT", orderId: "100", kind: "normal" },
  ]);
  assert.equal(result.syncMode, "incremental");
  assert.equal(result.requestedStartTime, requestedStartTime);
  assert.equal(result.effectiveStartTime, clientOptions.startTime);
});
