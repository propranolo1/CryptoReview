import assert from "node:assert/strict";
import test from "node:test";

import {
  createBasicOrderRecord,
  parseBasicOrdersFromOcrWords,
  reconcileBasicOrdersWithArchive,
} from "../lib/basic-orders.mjs";
import { reconstructBinanceUsdmReplays } from "../lib/binance-orders.mjs";

const IMAGE_WIDTH = 1200;

function word(text, xRatio, y, confidence = 94, width = 70) {
  const x = Math.round(IMAGE_WIDTH * xRatio);
  return {
    text,
    confidence,
    bbox: { x0: x, y0: y, x1: x + width, y1: y + 20 },
  };
}

function basicRow({
  y = 100,
  date = "2026-07-17",
  time = "21:07:30",
  symbol = "PUMPUSDT",
  type = "市价委托（条件委托）",
  direction = "平多",
  averagePrice = "0.0016094",
  price = "市价",
  executedQuantity = "921,365",
  originalQuantity = "921,365",
  asset = "PUMP",
  reduceOnly = "是",
  postOnly = "否",
  trigger = "—",
  status = "完全成交",
} = {}) {
  return [
    word(date, 0.015, y, 94, 112),
    word(time, 0.055, y, 94, 76),
    word(symbol, 0.095, y, 94, 96),
    word("永续", 0.098, y + 19, 90, 40),
    word(type, 0.185, y, 94, 150),
    word(direction, 0.278, y, 94, 52),
    ...(averagePrice === "—" ? [] : [word(averagePrice, 0.36, y, 94, 90)]),
    word(price, 0.442, y, 94, 90),
    word(executedQuantity, 0.524, y, 94, 90),
    word(asset, 0.552, y, 94, 52),
    word(originalQuantity, 0.615, y, 94, 90),
    word(asset, 0.645, y, 94, 52),
    word(reduceOnly, 0.703, y, 94, 25),
    word(postOnly, 0.782, y, 94, 25),
    word(trigger, 0.87, y, 94, 25),
    word(status, 0.944, y, 94, 70),
  ];
}

function record(overrides = {}) {
  return createBasicOrderRecord({
    symbol: "HYPEUSDT",
    createdAt: "2026-07-16T06:22:41.000Z",
    orderType: "LIMIT",
    positionAction: "openLong",
    averagePrice: 66.431,
    limitPrice: 66.431,
    executedQuantity: 22.88,
    originalQuantity: 22.88,
    reduceOnly: false,
    postOnly: false,
    triggerConditionRaw: null,
    status: "FILLED",
    confidence: 94,
    rawText: "HYPEUSDT 限价委托 开多",
    ...overrides,
  });
}

test("按基础单表格列解析条件市价平多，并按 UTC+8 保存为 U 本位订单", () => {
  const orders = parseBasicOrdersFromOcrWords(
    basicRow().reverse(),
    IMAGE_WIDTH,
  );

  assert.equal(orders.length, 1);
  assert.match(orders[0].orderId, /^ocr-basic-[0-9a-f]{8}$/);
  assert.equal(orders[0].userId, "ocr-basic-local");
  assert.equal(orders[0].createdAt, "2026-07-17T13:07:30.000Z");
  assert.equal(orders[0].updatedAt, orders[0].createdAt);
  assert.equal(orders[0].symbol, "PUMPUSDT");
  assert.equal(orders[0].orderType, "MARKET");
  assert.equal(orders[0].positionAction, "closeLong");
  assert.equal(orders[0].side, "SELL");
  assert.equal(orders[0].averagePrice, 0.0016094);
  assert.equal(orders[0].limitPrice, null);
  assert.equal(orders[0].executedQuantity, 921_365);
  assert.equal(orders[0].originalQuantity, 921_365);
  assert.equal(
    orders[0].executedQuoteQuantity,
    0.0016094 * 921_365,
  );
  assert.equal(orders[0].reduceOnly, true);
  assert.equal(orders[0].postOnly, false);
  assert.equal(orders[0].triggeredByCondition, true);
  assert.equal(orders[0].executionTimeKnown, false);
  assert.equal(orders[0].status, "FILLED");
});

test("四种开平方向分别映射为 Binance BUY/SELL", () => {
  const mappings = [
    ["openLong", "BUY"],
    ["closeLong", "SELL"],
    ["openShort", "SELL"],
    ["closeShort", "BUY"],
  ];

  for (const [positionAction, side] of mappings) {
    assert.equal(record({ positionAction }).side, side);
  }
});

test("同一基础单状态与成交进度更新时保持稳定订单号", () => {
  const pending = record({
    averagePrice: null,
    executedQuantity: 0,
    status: "NEW",
  });
  const filled = record({
    averagePrice: 66.431,
    executedQuantity: 22.88,
    status: "FILLED",
  });

  assert.equal(pending.orderId, filled.orderId);
});

test("取消或过期的零成交基础单会保留，但不会生成交易", () => {
  const orders = parseBasicOrdersFromOcrWords(
    basicRow({
      type: "限价委托",
      direction: "平多",
      averagePrice: "—",
      price: "67.17900",
      executedQuantity: "0.00",
      originalQuantity: "22.88",
      asset: "HYPE",
      reduceOnly: "是",
      status: "已过期",
      symbol: "HYPEUSDT",
    }),
    IMAGE_WIDTH,
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "EXPIRED");
  assert.equal(orders[0].executedQuantity, 0);
  assert.equal(orders[0].limitPrice, 67.179);
  assert.deepEqual(reconstructBinanceUsdmReplays(orders), {
    trades: [],
    warnings: [],
  });
});

test("基础单开仓和平仓可以直接重建一笔复盘", () => {
  const entry = record();
  const exit = record({
    createdAt: "2026-07-16T08:04:17.000Z",
    orderType: "MARKET",
    positionAction: "closeLong",
    averagePrice: 65.79016,
    limitPrice: null,
    reduceOnly: true,
    triggeredByCondition: true,
    rawText: "HYPEUSDT 市价委托（条件委托） 平多",
  });

  const reconstruction = reconstructBinanceUsdmReplays([entry, exit]);
  assert.equal(reconstruction.trades.length, 1);
  assert.equal(reconstruction.warnings.length, 0);
  assert.equal(reconstruction.trades[0].symbol, "HYPEUSDT");
  assert.equal(reconstruction.trades[0].side, "long");
  assert.equal(reconstruction.trades[0].entryPrice, 66.431);
  assert.equal(reconstruction.trades[0].exitPrice, 65.79016);
  assert.equal(reconstruction.trades[0].quantity, 22.88);
});

test("识别常见 OCR 小数丢点、千分位和英文状态", () => {
  const orders = parseBasicOrdersFromOcrWords([
    ...basicRow({
      y: 100,
      symbol: "HYPEUSDT",
      direction: "开多",
      type: "限价委托",
      averagePrice: "66.43100",
      price: "66.43100",
      executedQuantity: "22 88",
      originalQuantity: "22 88",
      asset: "HYPE",
      reduceOnly: "否",
      status: "FILLED",
    }),
    ...basicRow({
      y: 180,
      symbol: "ZECUSDT",
      direction: "平空",
      type: "限价委托",
      averagePrice: "525.20",
      price: "525.20",
      executedQuantity: "2849",
      originalQuantity: "2.849",
      asset: "ZEC",
      status: "完全成交",
    }),
  ], IMAGE_WIDTH);

  assert.equal(orders.length, 2);
  assert.equal(orders[0].executedQuantity, 22.88);
  assert.equal(orders[0].originalQuantity, 22.88);
  assert.equal(orders[1].executedQuantity, 2.849);
  assert.equal(orders[1].originalQuantity, 2.849);
});

test("兼容列补识别产生的重复汉字和限价倒序词元", () => {
  const words = basicRow({
    type: "价 限 委托",
    direction: "平 FE 多 多",
    status: "完全 成 完全 成交 交",
  });
  const orders = parseBasicOrdersFromOcrWords(words, IMAGE_WIDTH);

  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderType, "LIMIT");
  assert.equal(orders[0].positionAction, "closeLong");
  assert.equal(orders[0].status, "FILLED");
});

test("截图订单与已有 CSV 官方订单唯一匹配时不重复写入", () => {
  const ocr = record({
    createdAt: "2026-07-16T08:04:17.000Z",
    orderType: "MARKET",
    positionAction: "closeLong",
    averagePrice: 65.79016,
    limitPrice: null,
    reduceOnly: true,
  });
  const official = {
    ...ocr,
    userId: "123456789",
    orderId: "10909765328",
    averagePrice: 65.7901695,
    updatedAt: "2026-07-16T08:04:17.000Z",
  };
  delete official.source;
  delete official.positionAction;

  const result = reconcileBasicOrdersWithArchive([official], [ocr]);
  assert.deepEqual(result, {
    newOrders: [],
    matchedExistingCount: 1,
  });

  const nextDay = record({ createdAt: "2026-07-17T08:35:19.000Z" });
  const unmatched = reconcileBasicOrdersWithArchive([official], [nextDay]);
  assert.equal(unmatched.matchedExistingCount, 0);
  assert.deepEqual(unmatched.newOrders, [nextDay]);

  const mixed = reconcileBasicOrdersWithArchive([official], [ocr, nextDay]);
  assert.equal(mixed.matchedExistingCount, 1);
  assert.equal(mixed.newOrders.length, 1);
  assert.equal(mixed.newOrders[0].userId, official.userId);
});
