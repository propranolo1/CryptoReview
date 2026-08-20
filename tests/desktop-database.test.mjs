import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDesktopRepository } from "../desktop/database.mjs";

function createOrder(overrides = {}) {
  return {
    userId: "10001",
    symbol: "HYPEUSDT",
    orderId: "10905798348",
    status: "FILLED",
    updatedAt: "2026-07-16T07:33:17.000Z",
    details: { side: "BUY", quantity: 22.88 },
    ...overrides,
  };
}

function createTrade(overrides = {}) {
  return {
    id: "import-binance-futures-hype-10905798348",
    symbol: "HYPEUSDT",
    notes: "由订单历史生成",
    exits: [{ quantity: 22.88, exitPrice: 65.7901695 }],
    ...overrides,
  };
}

function createTrainingResult(overrides = {}) {
  return {
    id: "training-btc-1",
    symbol: "BTCUSDT",
    startedAt: "2026-07-18T02:00:00.000Z",
    endedAt: "2026-07-18T03:00:00.000Z",
    netPnl: 125.5,
    ...overrides,
  };
}

function createTemporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "cryptoreview-desktop-db-"));
  return {
    databasePath: join(directory, "cryptoreview.sqlite"),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("新数据库返回空订单、空复盘、空用户和空训练记录", () => {
  const repository = createDesktopRepository(":memory:");
  try {
    assert.deepEqual(repository.loadState(), {
      orders: [],
      trades: [],
      openPositions: [],
      trainingResults: [],
      profiles: [],
    });
  } finally {
    repository.close();
  }
});

test("复盘用户可保存并按传入顺序整体替换", () => {
  const repository = createDesktopRepository(":memory:");
  const self = {
    id: "profile-self",
    name: "我的账户",
    createdAt: "2026-07-31T00:00:00.000Z",
  };
  const xiaohong = {
    id: "profile-xiaohong",
    name: "小洪",
    createdAt: "2026-07-31T00:00:01.000Z",
  };

  try {
    repository.saveProfiles([self, xiaohong]);
    assert.deepEqual(repository.loadState().profiles, [self, xiaohong]);

    repository.saveProfiles([xiaohong]);
    assert.deepEqual(repository.loadState().profiles, [xiaohong]);
  } finally {
    repository.close();
  }
});

test("相同账户订单在不同复盘用户下不会互相覆盖", () => {
  const repository = createDesktopRepository(":memory:");
  const order = createOrder();

  try {
    repository.saveOrders([
      { ...order, profileId: "profile-self" },
      { ...order, profileId: "profile-xiaohong" },
    ]);
    const restored = repository.loadState().orders;
    assert.equal(restored.length, 2);
    assert.deepEqual(
      restored.map((item) => item.profileId).sort(),
      ["profile-self", "profile-xiaohong"],
    );
  } finally {
    repository.close();
  }
});

test("删除复盘用户会同时删除该用户的订单、复盘与档案", () => {
  const repository = createDesktopRepository(":memory:");
  const selfOrder = createOrder({ profileId: "profile-self" });
  const customOrder = createOrder({
    orderId: "custom-order",
    profileId: "profile-custom",
  });
  const selfTrade = createTrade({ profileId: "profile-self" });
  const customTrade = createTrade({ id: "custom-trade", profileId: "profile-custom" });

  try {
    repository.saveOrders([selfOrder, customOrder]);
    repository.saveTrades([selfTrade, customTrade]);
    repository.saveProfiles([
      { id: "profile-self", name: "我的账户", createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "profile-custom", name: "阿杰", createdAt: "2026-08-15T00:00:00.000Z" },
    ]);

    repository.deleteProfile("profile-custom");

    const state = repository.loadState();
    assert.deepEqual(state.orders, [selfOrder]);
    assert.deepEqual(state.trades, [selfTrade]);
    assert.deepEqual(state.profiles.map((profile) => profile.id), ["profile-self"]);
  } finally {
    repository.close();
  }
});

test("训练结果独立保存并按传入顺序整体替换", () => {
  const repository = createDesktopRepository(":memory:");
  const first = createTrainingResult();
  const second = createTrainingResult({ id: "training-btc-2", netPnl: -42 });

  try {
    repository.saveTrainingResults([second, first]);
    assert.deepEqual(repository.loadState().trainingResults, [second, first]);

    repository.saveTrainingResults([{ ...first, netPnl: 168 }]);
    assert.deepEqual(repository.loadState().trainingResults, [
      { ...first, netPnl: 168 },
    ]);

    assert.throws(
      () => repository.saveTrainingResults([first, { ...first, netPnl: 0 }]),
      /训练记录存在重复 id/,
    );
    assert.deepEqual(repository.loadState().trainingResults, [
      { ...first, netPnl: 168 },
    ]);

    repository.saveTrainingResults([]);
    assert.deepEqual(repository.loadState().trainingResults, []);
  } finally {
    repository.close();
  }
});

test("训练操作的完整 K 线位置、仓位快照和风控修改在重启后仍原样保留", () => {
  const temporary = createTemporaryDatabase();
  const completeRecord = createTrainingResult({
    actions: [{
      actionId: "training-btc-1-action-1",
      sequence: 1,
      operationSequence: 1,
      type: "open",
      time: "2026-07-18T02:01:00.000Z",
      recordedAt: "2026-07-18T02:01:00.000Z",
      side: "long",
      price: 64_000,
      quantity: 0.1,
      margin: 6_400,
      positionBefore: null,
      positionAfter: {
        side: "long",
        quantity: 0.1,
        averagePrice: 64_000,
        margin: 6_400,
      },
      marketLocation: {
        interval: "15m",
        candleOpenTimeMs: 1_721_267_200_000,
        candleCloseTimeMs: 1_721_268_099_999,
        candleIndex: 800,
        revealedOffset: 0,
        open: 63_900,
        high: 64_100,
        low: 63_800,
        close: 64_000,
        timing: "candle-close",
      },
    }],
    riskChanges: [{
      riskChangeId: "training-btc-1-risk-1",
      sequence: 1,
      operationSequence: 2,
      time: "2026-07-18T02:02:00.000Z",
      recordedAt: "2026-07-18T02:02:00.000Z",
      source: "drag",
      before: null,
      after: {
        takeProfit: 65_000,
        stopLoss: 63_500,
        updatedAt: "2026-07-18T02:02:00.000Z",
      },
      position: {
        side: "long",
        quantity: 0.1,
        averagePrice: 64_000,
        margin: 6_400,
      },
    }],
  });

  let repository = createDesktopRepository(temporary.databasePath);
  try {
    repository.saveTrainingResults([completeRecord]);
  } finally {
    repository.close();
  }

  repository = createDesktopRepository(temporary.databasePath);
  try {
    assert.deepEqual(repository.loadState().trainingResults, [completeRecord]);
  } finally {
    repository.close();
    temporary.cleanup();
  }
});

test("订单按账户、交易对和订单号更新，并在重新打开后保留完整 JSON", () => {
  const temporary = createTemporaryDatabase();
  const firstOrder = createOrder();
  const secondOrder = createOrder({
    userId: "20002",
    orderId: "10905798349",
    details: { side: "SELL", quantity: 1 },
  });

  let repository = createDesktopRepository(temporary.databasePath);
  try {
    repository.saveOrders([firstOrder, secondOrder]);
    repository.saveOrders([
      {
        ...firstOrder,
        status: "CANCELED",
        details: { side: "BUY", quantity: 20, reason: "用户撤单" },
      },
    ]);
  } finally {
    repository.close();
  }

  repository = createDesktopRepository(temporary.databasePath);
  try {
    const state = repository.loadState();
    assert.equal(state.orders.length, 2);
    assert.deepEqual(
      state.orders.find((order) => order.userId === "10001"),
      {
        ...firstOrder,
        status: "CANCELED",
        details: { side: "BUY", quantity: 20, reason: "用户撤单" },
      },
    );
    assert.deepEqual(
      state.orders.find((order) => order.userId === "20002"),
      secondOrder,
    );
  } finally {
    repository.close();
    temporary.cleanup();
  }
});

test("复盘按传入顺序保存，下一次保存会在事务内替换整个集合", () => {
  const repository = createDesktopRepository(":memory:");
  const hype = createTrade();
  const zec = createTrade({ id: "import-zec", symbol: "ZECUSDT" });
  const pump = createTrade({ id: "import-pump", symbol: "PUMPUSDT" });

  try {
    repository.saveTrades([zec, hype]);
    assert.deepEqual(repository.loadState().trades, [zec, hype]);

    repository.saveTrades([pump, { ...hype, notes: "保留的用户笔记" }]);
    assert.deepEqual(repository.loadState().trades, [
      pump,
      { ...hype, notes: "保留的用户笔记" },
    ]);

    repository.saveTrades([]);
    assert.deepEqual(repository.loadState().trades, []);
  } finally {
    repository.close();
  }
});

test("写入前严格校验数组与必要键，校验失败不会产生部分写入", () => {
  const repository = createDesktopRepository(":memory:");
  const existingOrder = createOrder();
  const existingTrade = createTrade();

  try {
    repository.saveOrders([existingOrder]);
    repository.saveTrades([existingTrade]);

    assert.throws(() => repository.saveOrders({}), /订单.*数组/);
    assert.throws(
      () =>
        repository.saveOrders([
          createOrder({ orderId: "new-order" }),
          { userId: "10001", symbol: "BTCUSDT" },
        ]),
      /orderId/,
    );
    assert.deepEqual(repository.loadState().orders, [existingOrder]);

    assert.throws(() => repository.saveTrades(null), /复盘.*数组/);
    assert.throws(
      () => repository.saveTrades([createTrade({ id: "new-trade" }), { id: "" }]),
      /id/,
    );
    assert.deepEqual(repository.loadState().trades, [existingTrade]);
  } finally {
    repository.close();
  }
});

test("复盘集合不接受重复 id，且不可序列化对象不会覆盖已有数据", () => {
  const repository = createDesktopRepository(":memory:");
  const existingTrade = createTrade();
  const circular = createTrade({ id: "circular" });
  circular.self = circular;

  try {
    repository.saveTrades([existingTrade]);
    assert.throws(
      () => repository.saveTrades([createTrade(), createTrade({ symbol: "BTCUSDT" })]),
      /重复.*id/,
    );
    assert.throws(() => repository.saveTrades([circular]), /JSON/);
    assert.deepEqual(repository.loadState().trades, [existingTrade]);
  } finally {
    repository.close();
  }
});

test("交易所同步快照在重启后保留当前仓位，空快照只清除同 provider/account", () => {
  const temporary = createTemporaryDatabase();
  const binanceAccountId = "binance-main";
  const okxAccountId = "okx-swap:okx-main";
  const binanceOrder = createOrder({
    userId: binanceAccountId,
    symbol: "BTCUSDT",
    orderId: "binance-order-1",
    exchangeProvider: "binance-usdm",
  });
  const okxOrder = createOrder({
    userId: okxAccountId,
    symbol: "ETHUSDT",
    orderId: "okx-order-1",
    exchangeProvider: "okx-swap",
  });
  const binancePosition = {
    userId: binanceAccountId,
    symbol: "BTCUSDT",
    positionSide: "LONG",
    side: "long",
    quantity: 0.25,
    entryPrice: 65_000,
    breakEvenPrice: 65_015,
    markPrice: 65_500,
    unRealizedProfit: 125,
    marginAsset: "USDT",
    updateTime: "2026-07-30T00:00:00.000Z",
  };
  const okxPosition = {
    userId: okxAccountId,
    symbol: "ETHUSDT",
    positionSide: "SHORT",
    side: "short",
    quantity: 2,
    entryPrice: 3_500,
    breakEvenPrice: null,
    markPrice: 3_450,
    unRealizedProfit: 100,
    marginAsset: "USDT",
    updateTime: "2026-07-30T00:01:00.000Z",
    provider: "okx",
    exchangeProvider: "okx-swap",
    instrumentId: "ETH-USDT-SWAP",
  };
  let repository = createDesktopRepository(temporary.databasePath);

  try {
    repository.saveExchangeSyncSnapshot({
      provider: "binance-usdm",
      accountId: binanceAccountId,
      orders: [binanceOrder],
      openPositions: [binancePosition],
      syncedAt: 1_785_369_600_000,
    });
    repository.saveExchangeSyncSnapshot({
      provider: "okx-swap",
      accountId: okxAccountId,
      orders: [okxOrder],
      openPositions: [okxPosition],
      syncedAt: 1_785_369_660_000,
    });
    repository.close();

    repository = createDesktopRepository(temporary.databasePath);
    assert.deepEqual(repository.loadState().orders, [binanceOrder, okxOrder]);
    assert.deepEqual(repository.loadState().openPositions, [
      { ...binancePosition, syncedAt: 1_785_369_600_000 },
      { ...okxPosition, syncedAt: 1_785_369_660_000 },
    ]);

    repository.saveExchangeSyncSnapshot({
      provider: "binance-usdm",
      accountId: binanceAccountId,
      orders: [],
      openPositions: [],
      syncedAt: 1_785_369_720_000,
    });
    repository.close();

    repository = createDesktopRepository(temporary.databasePath);
    const stateAfterEmptyBinanceSnapshot = repository.loadState();
    assert.deepEqual(stateAfterEmptyBinanceSnapshot.orders, [
      binanceOrder,
      okxOrder,
    ]);
    assert.deepEqual(stateAfterEmptyBinanceSnapshot.openPositions, [
      { ...okxPosition, syncedAt: 1_785_369_660_000 },
    ]);
  } finally {
    repository.close();
    temporary.cleanup();
  }
});

test("交易所同步时间在关闭重开后随每个未平仓快照恢复", () => {
  const temporary = createTemporaryDatabase();
  const accountId = "binance-snapshot-time";
  const syncedAt = Date.parse("2026-07-30T03:15:00.000Z");
  const openPositions = [
    {
      userId: accountId,
      symbol: "BTCUSDT",
      positionSide: "LONG",
      side: "long",
      quantity: 0.25,
      entryPrice: 65_000,
      markPrice: 65_500,
      updateTime: "2026-07-30T02:30:00.000Z",
    },
    {
      userId: accountId,
      symbol: "ETHUSDT",
      positionSide: "SHORT",
      side: "short",
      quantity: 2,
      entryPrice: 3_500,
      markPrice: 3_450,
      updateTime: "2026-07-30T02:31:00.000Z",
    },
  ];
  let repository = createDesktopRepository(temporary.databasePath);

  try {
    repository.saveExchangeSyncSnapshot({
      provider: "binance-usdm",
      accountId,
      orders: [],
      openPositions,
      syncedAt,
    });
    repository.close();

    repository = createDesktopRepository(temporary.databasePath);
    assert.deepEqual(
      repository.loadState().openPositions.map((position) => ({
        symbol: position.symbol,
        syncedAt: position.syncedAt,
      })),
      [
        { symbol: "BTCUSDT", syncedAt },
        { symbol: "ETHUSDT", syncedAt },
      ],
    );
  } finally {
    repository.close();
    temporary.cleanup();
  }
});

test("订单与复盘快照在同一事务中保存并完整恢复", () => {
  const temporary = createTemporaryDatabase();
  const repository = createDesktopRepository(temporary.databasePath);
  const orders = [createOrder({
    userId: "snapshot-account",
    symbol: "BTCUSDT",
    orderId: "snapshot-order",
  })];
  const trades = [{ id: "snapshot-trade", symbol: "BTCUSDT" }];

  try {
    repository.saveReplaySnapshot({ orders, trades });
    const state = repository.loadState();
    assert.deepEqual(state.orders, orders);
    assert.deepEqual(state.trades, trades);
  } finally {
    repository.close();
    temporary.cleanup();
  }
});
