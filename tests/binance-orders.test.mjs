import assert from "node:assert/strict";
import test from "node:test";

import {
  isBinanceUsdmOrderHistoryCsv,
  mergeBinanceApiReplays,
  mergeBinanceOrderRecords,
  mergeImportedReplays,
  parseBinanceUsdmOrderHistoryCsv,
  reconstructBinanceUsdmReplays,
} from "../lib/binance-orders.mjs";
import { calculateTradePnl } from "../lib/trade.mjs";

const header = "用户ID,时间,订单编号,代币名称/币种名称/币对,类型,方向,价格,平均价格,金额,执行金额,已执行报价金额,止损价格,状态,更新时间";
const rows = [
  "10001,2026-07-15 00:14:58,2048545046,SNDKUSDT,MARKET,SELL,0,1747.19,0.84,0.84,1467.6396,0,FILLED,2026-07-15 00:14:58",
  "10001,2026-07-15 11:03:53,803388810399,ZECUSDT,LIMIT,BUY,553.11,553.11,2.757,2.757,1524.92427,0,FILLED,2026-07-15 15:50:15",
  "10001,2026-07-15 17:06:44,803397154989,ZECUSDT,LIMIT,SELL,557.86,0,1.378,0,0,0,CANCELED,2026-07-15 17:21:06",
  "10001,2026-07-15 17:21:10,803397527895,ZECUSDT,MARKET,SELL,0,557.44765,1.378,1.378,768.16287,0,FILLED,2026-07-15 17:21:10",
  "10001,2026-07-15 17:22:28,803397563312,ZECUSDT,LIMIT,SELL,563.61,563.61,1.379,1.379,777.21819,0,FILLED,2026-07-15 18:05:19",
  "10001,2026-07-16 14:22:41,10905798348,HYPEUSDT,LIMIT,BUY,66.431,66.431,22.88,22.88,1519.94128,0,FILLED,2026-07-16 15:33:17",
  "10001,2026-07-16 15:35:25,10908281928,HYPEUSDT,LIMIT,SELL,67.179,0,22.88,0,0,0,EXPIRED,2026-07-16 16:04:17",
  "10001,2026-07-16 16:04:17,10909765328,HYPEUSDT,MARKET,SELL,0,65.7901695,22.88,22.88,1505.27908,0,FILLED,2026-07-16 16:04:17",
];
const csv = `\uFEFF${[header, ...rows].join("\r\n")}`;

function apiOrder({
  orderId,
  side,
  quantity,
  price,
  time,
  fills = [],
  symbol = "BTCUSDT",
  positionSide = "LONG",
}) {
  return {
    userId: "api-account",
    orderId,
    symbol,
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
    positionSide,
    sourceKind: "api-normal",
    fills,
  };
}

function apiFill({ tradeId, orderId, side, quantity, price, commission, time }) {
  return {
    tradeId,
    orderId,
    symbol: "BTCUSDT",
    side,
    positionSide: "LONG",
    price,
    quantity,
    quoteQuantity: price * quantity,
    commission,
    commissionAsset: "USDT",
    realizedPnl: side === "SELL" ? (price - 100) * quantity : 0,
    time,
    maker: false,
  };
}

test("识别并解析 Binance U 本位订单历史中文 CSV", () => {
  assert.equal(isBinanceUsdmOrderHistoryCsv(csv), true);
  assert.equal(isBinanceUsdmOrderHistoryCsv("symbol,side,quantity\nBTCUSDT,long,1"), false);

  const orders = parseBinanceUsdmOrderHistoryCsv(csv);
  assert.equal(orders.length, 8);
  assert.deepEqual(orders[5], {
    userId: "10001",
    orderId: "10905798348",
    symbol: "HYPEUSDT",
    orderType: "LIMIT",
    side: "BUY",
    limitPrice: 66.431,
    averagePrice: 66.431,
    originalQuantity: 22.88,
    executedQuantity: 22.88,
    executedQuoteQuantity: 1519.94128,
    stopPrice: null,
    status: "FILLED",
    createdAt: "2026-07-16T06:22:41.000Z",
    updatedAt: "2026-07-16T07:33:17.000Z",
  });
});

test("订单历史重建 HYPE 成交与动态平仓挂单，但不虚构止损和手续费", () => {
  const orders = parseBinanceUsdmOrderHistoryCsv(csv);
  const result = reconstructBinanceUsdmReplays(orders);
  const hype = result.trades.find((trade) => trade.symbol === "HYPEUSDT");

  assert.ok(hype);
  assert.equal(hype.side, "long");
  assert.equal(hype.quantity, 22.88);
  assert.equal(hype.entryPrice, 66.431);
  assert.equal(hype.entryTime, "2026-07-16T07:33:17.000Z");
  assert.equal(hype.exitPrice, 65.7901695);
  assert.equal(hype.exitTime, "2026-07-16T08:04:17.000Z");
  assert.equal(hype.marketDataSource, "binance-futures");
  assert.equal(hype.feesKnown, false);
  assert.equal(hype.stopLoss, null);
  assert.equal(hype.exitLabel, "平仓成交");
  assert.equal(hype.sourceEntryOrderId, "10905798348");
  assert.deepEqual(hype.sourceOrderIds, ["10905798348", "10908281928", "10909765328"]);
  assert.deepEqual(hype.riskLevels, [
    {
      id: "order-10908281928",
      orderId: "10908281928",
      kind: "takeProfit",
      inferred: true,
      price: 67.179,
      executionType: "limit",
      startTime: "2026-07-16T07:35:25.000Z",
      endTime: "2026-07-16T08:04:17.000Z",
      endState: "expired",
    },
  ]);
  assert.equal(Math.round(calculateTradePnl(hype).totalPnl * 10_000) / 10_000, -14.6622);
});

test("同一币对分批平仓组合成一笔复盘，孤立成交进入待确认警告", () => {
  const result = reconstructBinanceUsdmReplays(parseBinanceUsdmOrderHistoryCsv(csv));
  const zec = result.trades.find((trade) => trade.symbol === "ZECUSDT");

  assert.equal(result.trades.length, 2);
  assert.ok(zec);
  assert.deepEqual(zec.exits, [
    {
      quantity: 1.378,
      exitPrice: 557.44765,
      exitTime: "2026-07-15T09:21:10.000Z",
      fee: 0,
    },
    {
      quantity: 1.379,
      exitPrice: 563.61,
      exitTime: "2026-07-15T10:05:19.000Z",
      fee: 0,
    },
  ]);
  assert.equal(zec.riskLevels.length, 2);
  assert.deepEqual(result.warnings, [
    {
      code: "ambiguous_open_position",
      symbol: "SNDKUSDT",
      orderIds: ["2048545046"],
      message: "SNDKUSDT 在导入范围内没有形成完整开平仓，已保存订单但未生成复盘。",
    },
  ]);
});

test("相同订单按用户、币对和订单号更新，重复导入不会重复保存", () => {
  const [original] = parseBinanceUsdmOrderHistoryCsv(`\uFEFF${header}\n${rows[5]}`);
  const updated = { ...original, status: "CANCELED", updatedAt: "2026-07-16T08:00:00.000Z" };
  const otherAccount = { ...original, userId: "20002" };

  assert.deepEqual(mergeBinanceOrderRecords([original], [updated, otherAccount]), [
    updated,
    otherAccount,
  ]);
  assert.equal(mergeBinanceOrderRecords([original], [original]).length, 1);
});

test("重复生成的复盘按稳定来源键更新并保留用户笔记", () => {
  const result = reconstructBinanceUsdmReplays(parseBinanceUsdmOrderHistoryCsv(csv));
  const hype = result.trades.find((trade) => trade.symbol === "HYPEUSDT");
  const current = [
    {
      id: "hype-screenshot-review",
      orderIds: { entry: "10905798348" },
      notes: "默认截图笔记",
    },
    { ...hype, notes: "用户自己的复盘笔记", exits: [] },
  ];
  const incoming = [{ ...hype, notes: "自动生成笔记" }];
  const merged = mergeImportedReplays(current, incoming);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, hype.id);
  assert.equal(merged[0].notes, "用户自己的复盘笔记");
  assert.equal(merged[0].exits.length, 1);
});

test("CSV 重建保留已有 OCR 风险线和条件单原始记录，并按稳定 ID 去重", () => {
  const result = reconstructBinanceUsdmReplays(parseBinanceUsdmOrderHistoryCsv(csv));
  const hype = result.trades.find((trade) => trade.symbol === "HYPEUSDT");
  const conditionOrders = [
    {
      id: "ocr-condition-hype-sl",
      symbol: "HYPEUSDT",
      triggerPrice: 65.2,
    },
  ];
  const existingOcrRisk = {
    id: "ocr-risk-ocr-condition-hype-sl",
    kind: "stopLoss",
    price: 65.2,
    startTime: "2026-07-16T07:40:00.000Z",
    endTime: "2026-07-16T08:04:17.000Z",
    endState: "filled",
    executionType: "market",
    source: "ocr",
    ocrStatus: "filled",
    rawText: "existing OCR row",
  };
  const incomingOcrWithSameId = {
    ...existingOcrRisk,
    price: 64.8,
    rawText: "incoming stale OCR row",
  };
  const current = [
    {
      ...hype,
      riskLevels: [
        { ...hype.riskLevels[0], price: 999 },
        existingOcrRisk,
      ],
      conditionOrders,
    },
  ];
  const incoming = [
    {
      ...hype,
      riskLevels: [...hype.riskLevels, incomingOcrWithSameId],
    },
  ];

  const [merged] = mergeImportedReplays(current, incoming);
  assert.deepEqual(merged.riskLevels.map((level) => level.id), [
    "order-10908281928",
    "ocr-risk-ocr-condition-hype-sl",
  ]);
  assert.equal(merged.riskLevels[0].price, 67.179);
  assert.strictEqual(merged.riskLevels[1], existingOcrRisk);
  assert.strictEqual(merged.conditionOrders, conditionOrders);

  const [reimported] = mergeImportedReplays([merged], incoming);
  assert.deepEqual(reimported.riskLevels.map((level) => level.id), [
    "order-10908281928",
    "ocr-risk-ocr-condition-hype-sl",
  ]);
  assert.strictEqual(reimported.conditionOrders, conditionOrders);
});

test("订单行顺序变化不会改变生成复盘的稳定 ID", () => {
  const orders = parseBinanceUsdmOrderHistoryCsv(csv);
  const normal = reconstructBinanceUsdmReplays(orders).trades.map((trade) => trade.id).sort();
  const reversed = reconstructBinanceUsdmReplays([...orders].reverse()).trades.map((trade) => trade.id).sort();
  assert.deepEqual(reversed, normal);
});

test("PUMP 07-17 双向持仓 API 订单替代 OCR 副本并保留完整 SL 变动", () => {
  const base = {
    symbol: "PUMPUSDT",
    limitPrice: null,
    averagePrice: null,
    originalQuantity: 921365,
    executedQuantity: 0,
    executedQuoteQuantity: 0,
    stopPrice: null,
    status: "CANCELED",
  };
  const orders = [
    {
      ...base,
      userId: "ocr-basic-local",
      orderId: "ocr-basic-entry",
      orderType: "LIMIT",
      side: "BUY",
      limitPrice: 0.001637,
      averagePrice: 0.001637,
      executedQuantity: 921365,
      executedQuoteQuantity: 1508.474505,
      status: "FILLED",
      createdAt: "2026-07-17T09:41:57.000Z",
      updatedAt: "2026-07-17T09:41:57.000Z",
      source: "ocr-basic",
    },
    {
      ...base,
      userId: "ocr-basic-local",
      orderId: "ocr-basic-exit",
      orderType: "MARKET",
      side: "SELL",
      averagePrice: 0.0016094,
      executedQuantity: 921365,
      executedQuoteQuantity: 1482.998831,
      status: "FILLED",
      createdAt: "2026-07-17T13:07:30.000Z",
      updatedAt: "2026-07-17T13:07:30.000Z",
      source: "ocr-basic",
    },
    {
      ...base,
      userId: "api-account",
      orderId: "4949334074",
      orderType: "LIMIT",
      side: "BUY",
      limitPrice: 0.001637,
      averagePrice: 0.001637,
      executedQuantity: 921365,
      executedQuoteQuantity: 1508.474505,
      status: "FILLED",
      createdAt: "2026-07-17T09:41:57.727Z",
      updatedAt: "2026-07-17T09:42:01.726Z",
      positionSide: "LONG",
      sourceKind: "api-normal",
    },
    ...[
      ["1000002459074433", 0.00161, "2026-07-17T09:42:14.472Z", "2026-07-17T12:48:00.143Z", "CANCELED"],
      ["1000002459305964", 0.001625, "2026-07-17T12:48:00.304Z", "2026-07-17T12:48:18.206Z", "CANCELED"],
      ["1000002459306370", 0.001621, "2026-07-17T12:48:18.327Z", "2026-07-17T12:48:30.063Z", "CANCELED"],
      ["1000002459306619", 0.001614, "2026-07-17T12:48:30.223Z", "2026-07-17T13:07:30.393Z", "FILLED"],
    ].map(([orderId, stopPrice, createdAt, updatedAt, status]) => ({
      ...base,
      userId: "api-account",
      orderId: `algo:${orderId}`,
      orderType: "STOP_MARKET",
      side: "SELL",
      stopPrice,
      status,
      createdAt,
      updatedAt,
      positionSide: "LONG",
      sourceKind: "api-algo",
    })),
    {
      ...base,
      userId: "api-account",
      orderId: "4950223819",
      orderType: "MARKET",
      side: "SELL",
      averagePrice: 0.0016094,
      executedQuantity: 921365,
      executedQuoteQuantity: 1482.998831,
      status: "FILLED",
      createdAt: "2026-07-17T13:07:30.482Z",
      updatedAt: "2026-07-17T13:07:30.482Z",
      positionSide: "LONG",
      sourceKind: "api-normal",
    },
  ];

  const result = reconstructBinanceUsdmReplays(orders);
  assert.equal(result.trades.length, 1);
  assert.deepEqual(
    result.trades[0].riskLevels.map(({ price, endState, executionType }) => ({
      price,
      endState,
      executionType,
    })),
    [
      { price: 0.00161, endState: "cancelled", executionType: "market" },
      { price: 0.001625, endState: "cancelled", executionType: "market" },
      { price: 0.001621, endState: "cancelled", executionType: "market" },
      { price: 0.001614, endState: "filled", executionType: "market" },
    ],
  );

  const existingOcrReplay = {
    ...result.trades[0],
    id: "import-binance-futures-old-PUMPUSDT-ocr-basic-entry",
    sourceKey: "binance-futures:old:PUMPUSDT:ocr-basic-entry",
    sourceEntryOrderId: "ocr-basic-entry",
    sourceOrderIds: ["ocr-basic-entry", "ocr-basic-exit"],
    entryTime: "2026-07-17T09:41:57.000Z",
    exitTime: "2026-07-17T13:07:30.000Z",
    exits: [{ quantity: 921365, exitPrice: 0.0016094, exitTime: "2026-07-17T13:07:30.000Z", fee: 0 }],
    riskLevels: [],
  };
  const merged = mergeImportedReplays([existingOcrReplay], result.trades);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceEntryOrderId, "4949334074");
  assert.equal(merged[0].riskLevels.length, 4);
});

test("同一币对的 LONG 与 SHORT 双向持仓分别重建，不会互相抵消", () => {
  const order = (orderId, side, positionSide, price, time) => ({
    userId: "hedge-account",
    orderId,
    symbol: "BTCUSDT",
    orderType: "MARKET",
    side,
    limitPrice: null,
    averagePrice: price,
    originalQuantity: 1,
    executedQuantity: 1,
    executedQuoteQuantity: price,
    stopPrice: null,
    status: "FILLED",
    createdAt: time,
    updatedAt: time,
    positionSide,
    sourceKind: "api-normal",
  });
  const result = reconstructBinanceUsdmReplays([
    order("long-entry", "BUY", "LONG", 60000, "2026-07-17T00:00:00.000Z"),
    order("short-entry", "SELL", "SHORT", 61000, "2026-07-17T00:01:00.000Z"),
    order("long-exit", "SELL", "LONG", 62000, "2026-07-17T00:02:00.000Z"),
    order("short-exit", "BUY", "SHORT", 59000, "2026-07-17T00:03:00.000Z"),
  ]);

  assert.equal(result.trades.length, 2);
  assert.deepEqual(result.trades.map((trade) => trade.side).sort(), ["long", "short"]);
  const long = result.trades.find((trade) => trade.side === "long");
  const short = result.trades.find((trade) => trade.side === "short");
  assert.deepEqual([long.entryPrice, long.exitPrice], [60000, 62000]);
  assert.deepEqual([short.entryPrice, short.exitPrice], [61000, 59000]);
  assert.equal(result.warnings.length, 0);
});

test("官方入场单保留 OCR 别名，HYPE 与 SNDK 的旧复盘会被精确替换", () => {
  const buildFixture = ({
    symbol,
    quantity,
    entryPrice,
    exitPrice,
    ocrEntryId,
    officialEntryId,
    ocrEntryTime,
    officialEntryCreatedAt,
    officialEntryFilledAt,
    ocrExitId,
    officialExitId,
    ocrExitTime,
    officialExitTime,
  }) => {
    const base = {
      symbol,
      orderType: "MARKET",
      limitPrice: null,
      originalQuantity: quantity,
      executedQuantity: quantity,
      stopPrice: null,
      status: "FILLED",
    };
    return [
      {
        ...base,
        userId: "ocr-basic-local",
        orderId: ocrEntryId,
        side: "BUY",
        averagePrice: entryPrice,
        executedQuoteQuantity: entryPrice * quantity,
        createdAt: ocrEntryTime,
        updatedAt: ocrEntryTime,
        source: "ocr-basic",
      },
      {
        ...base,
        userId: "csv-account",
        orderId: officialEntryId,
        side: "BUY",
        averagePrice: entryPrice,
        executedQuoteQuantity: entryPrice * quantity,
        createdAt: ocrEntryTime,
        updatedAt: officialEntryFilledAt,
      },
      {
        ...base,
        userId: "api-account",
        orderId: officialEntryId,
        side: "BUY",
        averagePrice: entryPrice,
        executedQuoteQuantity: entryPrice * quantity,
        createdAt: officialEntryCreatedAt,
        updatedAt: officialEntryFilledAt,
        positionSide: "LONG",
        sourceKind: "api-normal",
      },
      {
        ...base,
        userId: "ocr-basic-local",
        orderId: ocrExitId,
        side: "SELL",
        averagePrice: exitPrice,
        executedQuoteQuantity: exitPrice * quantity,
        createdAt: ocrExitTime,
        updatedAt: ocrExitTime,
        source: "ocr-basic",
      },
      {
        ...base,
        userId: "api-account",
        orderId: officialExitId,
        side: "SELL",
        averagePrice: exitPrice,
        executedQuoteQuantity: exitPrice * quantity,
        createdAt: officialExitTime,
        updatedAt: officialExitTime,
        positionSide: "LONG",
        sourceKind: "api-normal",
      },
    ];
  };

  const fixtures = [
    {
      symbol: "HYPEUSDT",
      quantity: 23,
      entryPrice: 63.669,
      exitPrice: 63.692,
      ocrEntryId: "ocr-basic-1962ed5b",
      officialEntryId: "10808205736",
      ocrEntryTime: "2026-07-14T07:33:45.000Z",
      officialEntryCreatedAt: "2026-07-14T07:33:45.424Z",
      officialEntryFilledAt: "2026-07-14T07:41:28.515Z",
      ocrExitId: "ocr-basic-b8924a5d",
      officialExitId: "10811655606",
      ocrExitTime: "2026-07-14T09:31:38.000Z",
      officialExitTime: "2026-07-14T09:31:38.832Z",
    },
    {
      symbol: "SNDKUSDT",
      quantity: 0.84,
      entryPrice: 1757.11,
      exitPrice: 1747.19,
      ocrEntryId: "ocr-basic-fcd6c00a",
      officialEntryId: "2027922181",
      ocrEntryTime: "2026-07-14T12:58:14.000Z",
      officialEntryCreatedAt: "2026-07-14T12:58:14.423Z",
      officialEntryFilledAt: "2026-07-14T14:02:23.740Z",
      ocrExitId: "ocr-basic-sndk-exit",
      officialExitId: "2048545046",
      ocrExitTime: "2026-07-14T16:14:58.000Z",
      officialExitTime: "2026-07-14T16:14:58.765Z",
    },
  ];

  for (const fixture of fixtures) {
    const reconstruction = reconstructBinanceUsdmReplays(buildFixture(fixture));
    assert.equal(reconstruction.trades.length, 1);
    const [incoming] = reconstruction.trades;
    assert.equal(incoming.sourceEntryOrderId, fixture.officialEntryId);
    assert.ok(incoming.sourceEntryAliases.includes(fixture.ocrEntryId));
    assert.deepEqual(incoming.syncSources, ["binance-api", "binance-csv", "ocr-basic"]);

    const oldOcrReplay = {
      ...incoming,
      id: `import-binance-futures-old-${fixture.symbol}-${fixture.ocrEntryId}`,
      sourceKey: `binance-futures:old:${fixture.symbol}:${fixture.ocrEntryId}`,
      sourceEntryOrderId: fixture.ocrEntryId,
      sourceEntryAliases: [],
      sourceOrderIds: [fixture.ocrEntryId, fixture.ocrExitId],
      syncSources: ["ocr-basic"],
      entryTime: fixture.ocrEntryTime,
      exitTime: fixture.ocrExitTime,
      exits: [{
        quantity: fixture.quantity,
        exitPrice: fixture.exitPrice,
        exitTime: fixture.ocrExitTime,
        fee: 0,
      }],
      riskLevels: [],
    };
    const merged = mergeImportedReplays([oldOcrReplay], [incoming]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].sourceEntryOrderId, fixture.officialEntryId);
    assert.deepEqual(merged[0].syncSources, ["binance-api", "binance-csv", "ocr-basic"]);
  }
});

test("API 成交明细把真实开仓和平仓手续费写入复盘", () => {
  const entryTime = "2026-07-19T01:00:00.000Z";
  const exitTime = "2026-07-19T02:00:00.000Z";
  const entryFill = apiFill({
    tradeId: "fill-entry",
    orderId: "entry",
    side: "BUY",
    quantity: 2,
    price: 100,
    commission: 0.08,
    time: entryTime,
  });
  const exitFill = apiFill({
    tradeId: "fill-exit",
    orderId: "exit",
    side: "SELL",
    quantity: 2,
    price: 110,
    commission: 0.088,
    time: exitTime,
  });

  const result = reconstructBinanceUsdmReplays([
    apiOrder({ orderId: "entry", side: "BUY", quantity: 2, price: 100, time: entryTime, fills: [entryFill] }),
    apiOrder({ orderId: "exit", side: "SELL", quantity: 2, price: 110, time: exitTime, fills: [exitFill] }),
  ]);

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].fee, 0.08);
  assert.equal(result.trades[0].exits[0].fee, 0.088);
  assert.equal(result.trades[0].feesKnown, true);
  assert.equal(calculateTradePnl(result.trades[0]).totalPnl, 19.832);
});

test("订单重建保留基础开仓和加仓的逐笔来源，不再只留下聚合均价", () => {
  const firstEntryTime = "2026-07-19T01:00:00.000Z";
  const addedEntryTime = "2026-07-19T01:30:00.000Z";
  const exitTime = "2026-07-19T02:00:00.000Z";
  const result = reconstructBinanceUsdmReplays([
    apiOrder({
      orderId: "entry-base",
      side: "BUY",
      quantity: 2,
      price: 100,
      time: firstEntryTime,
      fills: [apiFill({
        tradeId: "fill-base",
        orderId: "entry-base",
        side: "BUY",
        quantity: 2,
        price: 100,
        commission: 0.08,
        time: firstEntryTime,
      })],
    }),
    apiOrder({
      orderId: "entry-add",
      side: "BUY",
      quantity: 1,
      price: 110,
      time: addedEntryTime,
      fills: [apiFill({
        tradeId: "fill-add",
        orderId: "entry-add",
        side: "BUY",
        quantity: 1,
        price: 110,
        commission: 0.044,
        time: addedEntryTime,
      })],
    }),
    apiOrder({
      orderId: "exit",
      side: "SELL",
      quantity: 3,
      price: 120,
      time: exitTime,
      fills: [apiFill({
        tradeId: "fill-exit",
        orderId: "exit",
        side: "SELL",
        quantity: 3,
        price: 120,
        commission: 0.144,
        time: exitTime,
      })],
    }),
  ]);

  assert.equal(result.trades.length, 1);
  assert.deepEqual(result.trades[0].entries, [
    {
      id: "fill-base",
      sourceOrderId: "entry-base",
      quantity: 2,
      entryPrice: 100,
      entryTime: firstEntryTime,
      fee: 0.08,
    },
    {
      id: "fill-add",
      sourceOrderId: "entry-add",
      quantity: 1,
      entryPrice: 110,
      entryTime: addedEntryTime,
      fee: 0.044,
    },
  ]);
  assert.equal(result.trades[0].quantity, 3);
  assert.ok(Math.abs(result.trades[0].entryPrice - (310 / 3)) < 1e-10);
});

test("当前仓位快照只为匹配到开仓历史的剩余仓位生成未平仓复盘", () => {
  const entryTime = "2026-07-19T01:00:00.000Z";
  const partialExitTime = "2026-07-19T02:00:00.000Z";
  const result = reconstructBinanceUsdmReplays([
    apiOrder({
      orderId: "entry",
      side: "BUY",
      quantity: 2,
      price: 100,
      time: entryTime,
      fills: [apiFill({
        tradeId: "fill-entry",
        orderId: "entry",
        side: "BUY",
        quantity: 2,
        price: 100,
        commission: 0.08,
        time: entryTime,
      })],
    }),
    apiOrder({
      orderId: "partial-exit",
      side: "SELL",
      quantity: 1,
      price: 110,
      time: partialExitTime,
      fills: [apiFill({
        tradeId: "fill-partial-exit",
        orderId: "partial-exit",
        side: "SELL",
        quantity: 1,
        price: 110,
        commission: 0.044,
        time: partialExitTime,
      })],
    }),
  ], {
    syncedAt: "2026-07-19T03:00:00.000Z",
    openPositions: [{
      userId: "api-account",
      symbol: "BTCUSDT",
      positionSide: "LONG",
      side: "long",
      quantity: 1,
      entryPrice: 100,
      breakEvenPrice: 100.08,
      markPrice: 112,
      unRealizedProfit: 12,
      marginAsset: "USDT",
      updateTime: "2026-07-19T02:30:00.000Z",
      fundingFeesKnown: true,
      fundingFees: [{
        userId: "api-account",
        transactionId: "funding-1",
        symbol: "BTCUSDT",
        incomeType: "FUNDING_FEE",
        amount: -0.75,
        asset: "USDT",
        time: "2026-07-19T02:00:00.000Z",
      }],
    }],
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.trades[0].exitTime, null);
  assert.equal(result.trades[0].exitPrice, null);
  assert.equal(result.trades[0].fee, 0.08);
  assert.equal(result.trades[0].exits[0].fee, 0.044);
  assert.equal(result.trades[0].feesKnown, true);
  assert.equal(result.trades[0].openPosition.markPrice, 112);
  assert.equal(result.trades[0].fundingFeesKnown, true);
  assert.equal(result.trades[0].fundingFee, -0.75);
  assert.equal(calculateTradePnl(result.trades[0], 112).totalPnl, 21.126);
});

test("API 更新会移除已经不在当前仓位快照里的旧未平仓复盘", () => {
  const staleOpen = {
    id: "open",
    sourceKey: "binance-futures:abc:BTCUSDT:entry",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 1,
    entryPrice: 100,
    entryTime: "2026-07-19T01:00:00.000Z",
    exitPrice: null,
    exitTime: null,
    openPosition: { markPrice: 101 },
  };
  const manual = { id: "manual", symbol: "ETHUSDT", exitTime: null };

  assert.deepEqual(mergeBinanceApiReplays([staleOpen, manual], []), [manual]);
});

test("缺失来源订单号不会通过字符串 undefined 合并不相关复盘", () => {
  const unrelatedExisting = {
    id: "import-manual-eth",
    symbol: "ETHUSDT",
    side: "long",
    quantity: 1,
    entryPrice: 2_000,
    entryTime: "2026-07-18T01:00:00.000Z",
    exitPrice: 2_100,
    exitTime: "2026-07-18T02:00:00.000Z",
    notes: "手工导入的无关交易",
  };
  const reconstructed = {
    id: "import-binance-futures-account-BTCUSDT-entry-1",
    sourceKey: "binance-futures:account:BTCUSDT:entry-1",
    sourceEntryOrderId: "entry-1",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 0.1,
    entryPrice: 60_000,
    entryTime: "2026-07-19T01:00:00.000Z",
    exitPrice: 61_000,
    exitTime: "2026-07-19T02:00:00.000Z",
  };

  const merged = mergeImportedReplays([unrelatedExisting], [reconstructed]);

  assert.equal(merged.length, 2);
  assert.ok(merged.some((trade) => trade.id === unrelatedExisting.id));
  assert.ok(merged.some((trade) => trade.id === reconstructed.id));
});

test("已保存未平仓复盘与无关订单重建交易必须同时保留", () => {
  const savedOpenPosition = {
    id: "import-binance-futures-account-SOLUSDT-open-1",
    sourceKey: "binance-futures:account:SOLUSDT:open-1",
    symbol: "SOLUSDT",
    side: "short",
    quantity: 5,
    entryPrice: 150,
    entryTime: "2026-07-20T01:00:00.000Z",
    exitPrice: null,
    exitTime: null,
    openPosition: {
      userId: "account",
      symbol: "SOLUSDT",
      positionSide: "SHORT",
      side: "short",
      quantity: 5,
      entryPrice: 150,
      markPrice: 145,
      unRealizedProfit: 25,
      marginAsset: "USDT",
      updateTime: "2026-07-20T02:00:00.000Z",
    },
  };
  const unrelatedReconstruction = {
    id: "import-binance-futures-account-BTCUSDT-entry-2",
    sourceKey: "binance-futures:account:BTCUSDT:entry-2",
    sourceEntryOrderId: "entry-2",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 0.2,
    entryPrice: 60_000,
    entryTime: "2026-07-21T01:00:00.000Z",
    exitPrice: 60_500,
    exitTime: "2026-07-21T02:00:00.000Z",
  };

  const merged = mergeImportedReplays(
    [savedOpenPosition],
    [unrelatedReconstruction],
  );

  assert.equal(merged.length, 2);
  assert.ok(
    merged.some(
      (trade) => trade.id === savedOpenPosition.id && trade.openPosition,
    ),
  );
  assert.ok(merged.some((trade) => trade.id === unrelatedReconstruction.id));
});

function binanceAccountOpenReplay({
  accountId,
  accountHash,
  symbol,
  entryOrderId,
  notes = "",
  riskLevels = [],
}) {
  return {
    id: `import-binance-futures-${accountHash}-${symbol}-${entryOrderId}`,
    sourceKey: `binance-futures:${accountHash}:${symbol}:${entryOrderId}`,
    sourceEntryOrderId: entryOrderId,
    symbol,
    side: "long",
    quantity: 1,
    entryPrice: 100,
    entryTime: "2026-07-22T01:00:00.000Z",
    exitPrice: null,
    exitTime: null,
    notes,
    riskLevels,
    openPosition: {
      exchangeProvider: "binance-usdm",
      userId: accountId,
      symbol,
      positionSide: "LONG",
      side: "long",
      quantity: 1,
      entryPrice: 100,
      markPrice: 105,
      unRealizedProfit: 5,
      marginAsset: "USDT",
      updateTime: "2026-07-22T02:00:00.000Z",
    },
  };
}

test("Binance 账户 B 同步为空仓时只清理账户 B 的旧未平仓复盘", () => {
  const accountARiskLevels = [{
    id: "account-a-ocr-sl",
    source: "ocr",
    kind: "stopLoss",
    price: 95,
    startTime: "2026-07-22T01:05:00.000Z",
  }];
  const accountA = binanceAccountOpenReplay({
    accountId: "binance-account-a",
    accountHash: "hash-a",
    symbol: "BTCUSDT",
    entryOrderId: "a-entry",
    notes: "账户 A 的复盘笔记",
    riskLevels: accountARiskLevels,
  });
  const staleAccountB = binanceAccountOpenReplay({
    accountId: "binance-account-b",
    accountHash: "hash-b",
    symbol: "SOLUSDT",
    entryOrderId: "b-stale-entry",
  });
  const okxOpen = {
    id: "import-okx-swap-okx-hash-ETHUSDT-okx-entry",
    sourceKey: "okx-swap:okx-hash:ETHUSDT:okx-entry",
    symbol: "ETHUSDT",
    openPosition: {
      exchangeProvider: "okx-swap",
      userId: "okx-account",
      markPrice: 3_500,
    },
  };
  const manual = {
    id: "manual-open",
    symbol: "XRPUSDT",
    notes: "手工记录",
    exitTime: null,
  };

  const merged = mergeBinanceApiReplays(
    [accountA, staleAccountB, okxOpen, manual],
    [],
    { accountId: "binance-account-b" },
  );

  assert.deepEqual(merged.map((trade) => trade.id), [
    accountA.id,
    okxOpen.id,
    manual.id,
  ]);
  assert.deepEqual(merged.find((trade) => trade.id === accountA.id), accountA);
  assert.equal(
    merged.find((trade) => trade.id === accountA.id).notes,
    "账户 A 的复盘笔记",
  );
  assert.deepEqual(
    merged.find((trade) => trade.id === accountA.id).riskLevels,
    accountARiskLevels,
  );
});

test("Binance 账户 B 同步新仓时替换账户 B 旧仓并保留其他来源复盘", () => {
  const accountA = binanceAccountOpenReplay({
    accountId: "binance-account-a",
    accountHash: "hash-a",
    symbol: "BTCUSDT",
    entryOrderId: "a-entry",
    notes: "账户 A 保留",
    riskLevels: [{
      id: "account-a-tp",
      source: "ocr",
      kind: "takeProfit",
      price: 110,
    }],
  });
  const staleAccountB = binanceAccountOpenReplay({
    accountId: "binance-account-b",
    accountHash: "hash-b",
    symbol: "SOLUSDT",
    entryOrderId: "b-stale-entry",
  });
  const newAccountB = binanceAccountOpenReplay({
    accountId: "binance-account-b",
    accountHash: "hash-b",
    symbol: "ETHUSDT",
    entryOrderId: "b-new-entry",
  });
  const okxOpen = {
    id: "import-okx-swap-okx-hash-DOGEUSDT-okx-entry",
    sourceKey: "okx-swap:okx-hash:DOGEUSDT:okx-entry",
    symbol: "DOGEUSDT",
    openPosition: {
      exchangeProvider: "okx-swap",
      userId: "okx-account",
      markPrice: 0.15,
    },
  };
  const manual = { id: "manual-closed", symbol: "BNBUSDT", exitTime: "2026-07-22T03:00:00.000Z" };

  const merged = mergeBinanceApiReplays(
    [accountA, staleAccountB, okxOpen, manual],
    [newAccountB],
    { accountId: "binance-account-b" },
  );

  assert.deepEqual(
    new Set(merged.map((trade) => trade.id)),
    new Set([newAccountB.id, accountA.id, okxOpen.id, manual.id]),
  );
  assert.ok(!merged.some((trade) => trade.id === staleAccountB.id));
  assert.deepEqual(merged.find((trade) => trade.id === accountA.id), accountA);
});

test("冷启动重建未平仓交易优先使用持久化快照时间而不是旧持仓更新时间", () => {
  const entryTime = "2026-07-30T01:00:00.000Z";
  const stalePositionUpdateTime = "2026-07-30T02:30:00.000Z";
  const snapshotSyncedAt = Date.parse("2026-07-30T03:15:00.000Z");
  const result = reconstructBinanceUsdmReplays([
    apiOrder({
      orderId: "snapshot-entry",
      side: "BUY",
      quantity: 1,
      price: 65_000,
      time: entryTime,
    }),
  ], {
    openPositions: [{
      userId: "api-account",
      symbol: "BTCUSDT",
      positionSide: "LONG",
      side: "long",
      quantity: 1,
      entryPrice: 65_000,
      markPrice: 65_500,
      updateTime: stalePositionUpdateTime,
      syncedAt: snapshotSyncedAt,
    }],
  });

  assert.equal(result.trades.length, 1);
  assert.equal(
    result.trades[0].openPosition.syncedAt,
    new Date(snapshotSyncedAt).toISOString(),
  );
  assert.notEqual(
    result.trades[0].openPosition.syncedAt,
    stalePositionUpdateTime,
  );
});
