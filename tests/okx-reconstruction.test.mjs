import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeBinanceOrderRecords,
  mergeImportedReplays,
  mergeOkxApiReplays,
  reconstructBinanceUsdmReplays,
} from "../lib/binance-orders.mjs";

function apiOrder({
  provider,
  userId,
  orderId,
  side,
  price,
  quantity = 1,
  time,
  fills = [],
}) {
  const okx = provider === "okx-swap";
  return {
    exchangeProvider: provider,
    userId,
    orderId,
    symbol: "BTCUSDT",
    orderType: "MARKET",
    side,
    limitPrice: null,
    averagePrice: price,
    originalQuantity: quantity,
    executedQuantity: quantity,
    executedQuoteQuantity: price * quantity,
    stopPrice: null,
    status: "FILLED",
    createdAt: time,
    updatedAt: time,
    positionSide: "LONG",
    sourceKind: okx ? "okx-api-normal" : "api-normal",
    fills,
  };
}

function fill({ provider, orderId, side, price, quantity, commission, time }) {
  return {
    tradeId: `${provider}-${orderId}-fill`,
    orderId,
    symbol: "BTCUSDT",
    side,
    positionSide: "LONG",
    price,
    quantity,
    quoteQuantity: price * quantity,
    commission,
    commissionAsset: "USDT",
    realizedPnl: 0,
    time,
    maker: false,
  };
}

test("OKX 订单生成独立来源的复盘，并沿用公共 Binance 合约行情", () => {
  const entryTime = "2026-07-20T01:00:00.000Z";
  const exitTime = "2026-07-20T02:00:00.000Z";
  const provider = "okx-swap";
  const userId = "okx-swap:account";
  const orders = [
    apiOrder({
      provider,
      userId,
      orderId: "entry",
      side: "BUY",
      price: 100,
      time: entryTime,
      fills: [fill({
        provider,
        orderId: "entry",
        side: "BUY",
        price: 100,
        quantity: 1,
        commission: 0.04,
        time: entryTime,
      })],
    }),
    apiOrder({
      provider,
      userId,
      orderId: "exit",
      side: "SELL",
      price: 110,
      time: exitTime,
      fills: [fill({
        provider,
        orderId: "exit",
        side: "SELL",
        price: 110,
        quantity: 1,
        commission: 0.044,
        time: exitTime,
      })],
    }),
  ];

  const result = reconstructBinanceUsdmReplays(orders);

  assert.equal(result.trades.length, 1);
  assert.match(result.trades[0].id, /^import-okx-swap-/);
  assert.match(result.trades[0].sourceKey, /^okx-swap:/);
  assert.equal(result.trades[0].strategy, "OKX U 本位永续订单重建");
  assert.deepEqual(result.trades[0].syncSources, ["okx-api"]);
  assert.equal(result.trades[0].marketDataSource, "binance-futures");
  assert.equal(result.trades[0].fee, 0.04);
  assert.equal(result.trades[0].exits[0].fee, 0.044);
});

test("相同账户文本与订单号的 Binance、OKX 记录不会跨交易所合并", () => {
  const entryTime = "2026-07-20T01:00:00.000Z";
  const exitTime = "2026-07-20T02:00:00.000Z";
  const buildProviderOrders = (provider) => [
    apiOrder({
      provider,
      userId: "same-account-text",
      orderId: "entry",
      side: "BUY",
      price: 100,
      time: entryTime,
    }),
    apiOrder({
      provider,
      userId: "same-account-text",
      orderId: "exit",
      side: "SELL",
      price: 110,
      time: exitTime,
    }),
  ];

  const stored = mergeBinanceOrderRecords(
    buildProviderOrders("binance-usdm"),
    buildProviderOrders("okx-swap"),
  );
  const reconstruction = reconstructBinanceUsdmReplays(stored);

  assert.equal(stored.length, 4);
  assert.equal(reconstruction.trades.length, 2);
  assert.deepEqual(
    reconstruction.trades.map((trade) => trade.syncSources[0]).sort(),
    ["binance-api", "okx-api"],
  );
});

test("OKX 更新只清理消失的 OKX 未平仓复盘", () => {
  const staleOkx = {
    id: "import-okx-swap-old",
    sourceKey: "okx-swap:abc:BTCUSDT:entry",
    symbol: "BTCUSDT",
    openPosition: { markPrice: 101 },
  };
  const staleBinance = {
    id: "import-binance-futures-old",
    sourceKey: "binance-futures:abc:BTCUSDT:entry",
    symbol: "BTCUSDT",
    openPosition: { markPrice: 101 },
  };
  const manual = { id: "manual", symbol: "ETHUSDT", exitTime: null };

  assert.deepEqual(
    mergeOkxApiReplays([staleOkx, staleBinance, manual], []),
    [staleBinance, manual],
  );
});

test("OKX 返佣使用负手续费保留在复盘盈亏证据中", () => {
  const entryTime = "2026-07-20T01:00:00.000Z";
  const exitTime = "2026-07-20T02:00:00.000Z";
  const provider = "okx-swap";
  const userId = "okx-swap:rebate";
  const result = reconstructBinanceUsdmReplays([
    apiOrder({
      provider,
      userId,
      orderId: "entry",
      side: "BUY",
      price: 100,
      time: entryTime,
      fills: [fill({
        provider,
        orderId: "entry",
        side: "BUY",
        price: 100,
        quantity: 1,
        commission: -0.01,
        time: entryTime,
      })],
    }),
    apiOrder({
      provider,
      userId,
      orderId: "exit",
      side: "SELL",
      price: 110,
      time: exitTime,
      fills: [fill({
        provider,
        orderId: "exit",
        side: "SELL",
        price: 110,
        quantity: 1,
        commission: 0.044,
        time: exitTime,
      })],
    }),
  ]);

  assert.equal(result.trades[0].feesKnown, true);
  assert.equal(result.trades[0].fee, -0.01);
  assert.equal(result.trades[0].commissionByAsset.USDT, 0.034);
});

test("OKX 条件单缺少官方撤销时刻时明确标记时间为推定", () => {
  const provider = "okx-swap";
  const userId = "okx-swap:estimated-lifecycle";
  const result = reconstructBinanceUsdmReplays([
    apiOrder({
      provider,
      userId,
      orderId: "entry",
      side: "BUY",
      price: 100,
      time: "2026-07-20T01:00:00.000Z",
    }),
    {
      ...apiOrder({
        provider,
        userId,
        orderId: "okx-algo:sl",
        side: "SELL",
        price: 90,
        quantity: 1,
        time: "2026-07-20T01:30:00.000Z",
      }),
      orderType: "STOP_MARKET",
      averagePrice: null,
      executedQuantity: 0,
      executedQuoteQuantity: 0,
      stopPrice: 90,
      status: "CANCELED",
      sourceKind: "okx-api-algo",
      lifecycleTimeEstimated: true,
    },
    apiOrder({
      provider,
      userId,
      orderId: "exit",
      side: "SELL",
      price: 110,
      time: "2026-07-20T02:00:00.000Z",
    }),
  ]);

  assert.equal(result.trades[0].riskLevels.length, 1);
  assert.equal(result.trades[0].riskLevels[0].inferred, true);
});

test("相同成交证据不会把已知 Binance 与 OKX 复盘互相替换", () => {
  const shared = {
    sourceEntryOrderId: "same-entry-id",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 1,
    entryPrice: 100,
    entryTime: "2026-07-20T01:00:00.000Z",
    exitPrice: 110,
    exitTime: "2026-07-20T02:00:00.000Z",
  };
  const binance = {
    ...shared,
    id: "import-binance-futures-a",
    sourceKey: "binance-futures:a:BTCUSDT:same-entry-id",
  };
  const okx = {
    ...shared,
    id: "import-okx-swap-a",
    sourceKey: "okx-swap:a:BTCUSDT:same-entry-id",
  };

  const merged = mergeImportedReplays([binance], [okx]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((trade) => trade.id === binance.id));
  assert.ok(merged.some((trade) => trade.id === okx.id));
});

function okxAccountOpenReplay({
  accountId,
  accountHash,
  symbol,
  entryOrderId,
  notes = "",
  riskLevels = [],
}) {
  return {
    id: `import-okx-swap-${accountHash}-${symbol}-${entryOrderId}`,
    sourceKey: `okx-swap:${accountHash}:${symbol}:${entryOrderId}`,
    sourceEntryOrderId: entryOrderId,
    symbol,
    side: "short",
    quantity: 1,
    entryPrice: 100,
    entryTime: "2026-07-23T01:00:00.000Z",
    exitPrice: null,
    exitTime: null,
    notes,
    riskLevels,
    openPosition: {
      exchangeProvider: "okx-swap",
      userId: accountId,
      symbol,
      positionSide: "SHORT",
      side: "short",
      quantity: 1,
      entryPrice: 100,
      markPrice: 95,
      unRealizedProfit: 5,
      marginAsset: "USDT",
      updateTime: "2026-07-23T02:00:00.000Z",
    },
  };
}

test("OKX 账户 B 同步为空仓时只清理账户 B 的旧未平仓复盘", () => {
  const accountARiskLevels = [{
    id: "okx-account-a-ocr-tp",
    source: "ocr",
    kind: "takeProfit",
    price: 90,
    startTime: "2026-07-23T01:10:00.000Z",
  }];
  const accountA = okxAccountOpenReplay({
    accountId: "okx-swap:account-a",
    accountHash: "hash-a",
    symbol: "BTCUSDT",
    entryOrderId: "a-entry",
    notes: "OKX 账户 A 的复盘笔记",
    riskLevels: accountARiskLevels,
  });
  const staleAccountB = okxAccountOpenReplay({
    accountId: "okx-swap:account-b",
    accountHash: "hash-b",
    symbol: "SOLUSDT",
    entryOrderId: "b-stale-entry",
  });
  const binanceOpen = {
    id: "import-binance-futures-binance-hash-ETHUSDT-binance-entry",
    sourceKey: "binance-futures:binance-hash:ETHUSDT:binance-entry",
    symbol: "ETHUSDT",
    openPosition: {
      exchangeProvider: "binance-usdm",
      userId: "binance-account",
      markPrice: 3_500,
    },
  };
  const manual = {
    id: "manual-open",
    symbol: "XRPUSDT",
    notes: "手工记录",
    exitTime: null,
  };

  const merged = mergeOkxApiReplays(
    [accountA, staleAccountB, binanceOpen, manual],
    [],
    { accountId: "okx-swap:account-b" },
  );

  assert.deepEqual(merged.map((trade) => trade.id), [
    accountA.id,
    binanceOpen.id,
    manual.id,
  ]);
  assert.deepEqual(merged.find((trade) => trade.id === accountA.id), accountA);
  assert.equal(
    merged.find((trade) => trade.id === accountA.id).notes,
    "OKX 账户 A 的复盘笔记",
  );
  assert.deepEqual(
    merged.find((trade) => trade.id === accountA.id).riskLevels,
    accountARiskLevels,
  );
});

test("OKX 账户 B 同步新仓时替换账户 B 旧仓并保留其他来源复盘", () => {
  const accountA = okxAccountOpenReplay({
    accountId: "okx-swap:account-a",
    accountHash: "hash-a",
    symbol: "BTCUSDT",
    entryOrderId: "a-entry",
    notes: "OKX 账户 A 保留",
    riskLevels: [{
      id: "okx-account-a-sl",
      source: "ocr",
      kind: "stopLoss",
      price: 105,
    }],
  });
  const staleAccountB = okxAccountOpenReplay({
    accountId: "okx-swap:account-b",
    accountHash: "hash-b",
    symbol: "SOLUSDT",
    entryOrderId: "b-stale-entry",
  });
  const newAccountB = okxAccountOpenReplay({
    accountId: "okx-swap:account-b",
    accountHash: "hash-b",
    symbol: "ETHUSDT",
    entryOrderId: "b-new-entry",
  });
  const binanceOpen = {
    id: "import-binance-futures-binance-hash-DOGEUSDT-binance-entry",
    sourceKey: "binance-futures:binance-hash:DOGEUSDT:binance-entry",
    symbol: "DOGEUSDT",
    openPosition: {
      exchangeProvider: "binance-usdm",
      userId: "binance-account",
      markPrice: 0.15,
    },
  };
  const manual = { id: "manual-closed", symbol: "BNBUSDT", exitTime: "2026-07-23T03:00:00.000Z" };

  const merged = mergeOkxApiReplays(
    [accountA, staleAccountB, binanceOpen, manual],
    [newAccountB],
    { accountId: "okx-swap:account-b" },
  );

  assert.deepEqual(
    new Set(merged.map((trade) => trade.id)),
    new Set([newAccountB.id, accountA.id, binanceOpen.id, manual.id]),
  );
  assert.ok(!merged.some((trade) => trade.id === staleAccountB.id));
  assert.deepEqual(merged.find((trade) => trade.id === accountA.id), accountA);
});
