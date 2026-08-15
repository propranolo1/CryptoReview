import assert from "node:assert/strict";
import test from "node:test";

import {
  attachConditionOrdersToTrades,
  parseConditionOrdersFromOcrWords,
} from "../lib/conditional-orders.mjs";

const IMAGE_WIDTH = 1200;

function tesseractWord(text, x, y, confidence = 94, width = 70) {
  return {
    text,
    confidence,
    bbox: { x0: x, y0: y, x1: x + width, y1: y + 20 },
  };
}

function ocrRow({
  y,
  date,
  time,
  symbol,
  closeSide,
  kind = "止盈止损",
  comparator,
  triggerPrice,
  executionType,
  quantity,
  asset,
  status,
}) {
  return [
    tesseractWord(date, 22, y, 94, 112),
    tesseractWord(time, 140, y, 94, 76),
    tesseractWord(symbol, 238, y, 94, 96),
    tesseractWord(closeSide, 352, y, 94, 54),
    tesseractWord(kind, 424, y, 94, 92),
    tesseractWord(comparator, 548, y, 94, 32),
    tesseractWord(String(triggerPrice), 596, y, 94, 78),
    tesseractWord(executionType, 704, y, 94, 54),
    tesseractWord(String(quantity), 810, y, 94, 86),
    tesseractWord(asset, 914, y, 94, 64),
    tesseractWord(status, 1050, y, 94, 72),
  ];
}

function conditionOrder(overrides = {}) {
  return {
    id: "ocr-condition-default",
    symbol: "HYPEUSDT",
    createdTime: "2026-07-16T07:35:25.000Z",
    closeSide: "closeLong",
    kind: "stopLoss",
    executionType: "market",
    triggerPrice: 65.2,
    comparator: "<=",
    quantity: 22.88,
    asset: "HYPE",
    status: "filled",
    confidence: 94,
    rawText: "HYPE 条件单",
    ...overrides,
  };
}

test("按日期锚点与横向列顺序解析 HYPE 平多止损市价单，并把 UTC+8 转为 ISO", () => {
  const words = [
    tesseractWord("条件单历史", 20, 20, 99, 120),
    ...ocrRow({
      y: 100,
      date: "2026-07-16",
      time: "15:35:25",
      symbol: "HYPEUSDT",
      closeSide: "平多",
      comparator: "≤",
      triggerPrice: "65.200",
      executionType: "市价",
      quantity: "22.88",
      asset: "HYPE",
      status: "已触发",
    }),
  ].reverse();

  const orders = parseConditionOrdersFromOcrWords(words, IMAGE_WIDTH);
  assert.equal(orders.length, 1);
  assert.match(orders[0].id, /^ocr-condition-[0-9a-f]{8}$/);
  assert.deepEqual({ ...orders[0], id: undefined }, {
    id: undefined,
    symbol: "HYPEUSDT",
    createdTime: "2026-07-16T07:35:25.000Z",
    closeSide: "closeLong",
    kind: "stopLoss",
    executionType: "market",
    triggerPrice: 65.2,
    comparator: "<=",
    quantity: 22.88,
    asset: "HYPE",
    status: "filled",
    confidence: 94,
    rawText: "2026-07-16 15:35:25 HYPEUSDT 平多 止盈止损 ≤ 65.200 市价 22.88 HYPE 已触发",
  });

  const repeated = parseConditionOrdersFromOcrWords([...words].reverse(), IMAGE_WIDTH);
  assert.equal(repeated[0].id, orders[0].id);
});

test("明确止盈优先于比较符推断，并解析 PUMP 平多止盈市价单", () => {
  const orders = parseConditionOrdersFromOcrWords(
    ocrRow({
      y: 100,
      date: "2026-07-16",
      time: "22:10:00",
      symbol: "PUMPUSDT",
      closeSide: "平多",
      kind: "止盈",
      comparator: "<=",
      triggerPrice: "0.001650",
      executionType: "MARKET",
      quantity: "1007485",
      asset: "PUMP",
      status: "FILLED",
    }),
    IMAGE_WIDTH,
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].kind, "takeProfit");
  assert.equal(orders[0].executionType, "market");
  assert.equal(orders[0].triggerPrice, 0.00165);
  assert.equal(orders[0].quantity, 1_007_485);
  assert.equal(orders[0].status, "filled");
});

test("兼容真实截图中的小数点误识别、完成状态和零成交数量", () => {
  const words = ocrRow({
    y: 100,
    date: "2026-07-16",
    time: "15:35:03",
    symbol: "HYPEUSDT",
    closeSide: "平多",
    comparator: "<=",
    triggerPrice: "65-90000",
    executionType: "市价",
    quantity: "0.000",
    asset: "HYPE",
    status: "已完成",
  });

  const orders = parseConditionOrdersFromOcrWords(words, IMAGE_WIDTH);

  assert.equal(orders.length, 1);
  assert.equal(orders[0].triggerPrice, 65.9);
  assert.equal(orders[0].quantity, 0);
  assert.equal(orders[0].status, "filled");
  assert.equal(orders[0].kind, "stopLoss");

  const cancelledWords = words.map((word) =>
    word.text === "已完成" ? { ...word, text: "已取消" } : word,
  );
  const cancelled = parseConditionOrdersFromOcrWords(cancelledWords, IMAGE_WIDTH);
  assert.equal(cancelled[0].status, "cancelled");
  assert.equal(cancelled[0].id, orders[0].id);
});

test("止盈止损合并标签按平仓方向和比较符分类，并识别 LIMIT 与状态", () => {
  const rows = [
    ...ocrRow({
      y: 100,
      date: "2026-07-15",
      time: "18:10:00",
      symbol: "PUMPUSDT",
      closeSide: "平多",
      comparator: ">=",
      triggerPrice: "0.0017",
      executionType: "市价",
      quantity: "100",
      asset: "PUMP",
      status: "已过期",
    }),
    ...ocrRow({
      y: 180,
      date: "2026-07-16",
      time: "10:20:00",
      symbol: "ZECUSDT",
      closeSide: "平空",
      comparator: ">=",
      triggerPrice: "570",
      executionType: "限价",
      quantity: "2.5",
      asset: "ZEC",
      status: "已取消",
    }),
    ...ocrRow({
      y: 260,
      date: "2026-07-16",
      time: "11:20:00",
      symbol: "ZECUSDT",
      closeSide: "平空",
      comparator: "<=",
      triggerPrice: "550",
      executionType: "市价",
      quantity: "2.5",
      asset: "ZEC",
      status: "处理中",
    }),
  ];

  const orders = parseConditionOrdersFromOcrWords(
    rows.reverse(),
    IMAGE_WIDTH,
  );

  assert.deepEqual(
    orders.map((order) => ({
      symbol: order.symbol,
      kind: order.kind,
      closeSide: order.closeSide,
      executionType: order.executionType,
      status: order.status,
    })),
    [
      {
        symbol: "PUMPUSDT",
        kind: "takeProfit",
        closeSide: "closeLong",
        executionType: "market",
        status: "expired",
      },
      {
        symbol: "ZECUSDT",
        kind: "stopLoss",
        closeSide: "closeShort",
        executionType: "limit",
        status: "cancelled",
      },
      {
        symbol: "ZECUSDT",
        kind: "takeProfit",
        closeSide: "closeShort",
        executionType: "market",
        status: "unknown",
      },
    ],
  );
});

test("按币对所在的真实表格行分组，兼容相邻行时间分隔符损坏而不串行", () => {
  const hypeWords = ocrRow({
    y: 520,
    date: "2026-07-16",
    time: "15:35:03",
    symbol: "HYPEUSDT",
    closeSide: "平多",
    comparator: "<=",
    triggerPrice: "65-90000",
    executionType: "市价",
    quantity: "22.88",
    asset: "HYPE",
    status: "已完成",
  }).map((word) => word.text === "HYPEUSDT"
    ? { ...word, bbox: { ...word.bbox, y0: 500, y1: 517 } }
    : word);
  const zecWords = ocrRow({
    y: 616,
    date: "2026-07-16",
    time: "10:56:-51",
    symbol: "ZECUSDT",
    closeSide: "平多",
    comparator: "<-",
    triggerPrice: "564.86",
    executionType: "市价",
    quantity: "2.717",
    asset: "ZEC",
    status: "已完成",
  }).map((word) => word.text === "ZECUSDT"
    ? { ...word, bbox: { ...word.bbox, y0: 596, y1: 613 } }
    : word);

  const orders = parseConditionOrdersFromOcrWords(
    [...zecWords, ...hypeWords].reverse(),
    IMAGE_WIDTH,
  );

  assert.equal(orders.length, 2);
  assert.deepEqual(
    orders.map((order) => [order.symbol, order.triggerPrice, order.createdTime]),
    [
      ["ZECUSDT", 564.86, "2026-07-16T02:56:51.000Z"],
      ["HYPEUSDT", 65.9, "2026-07-16T07:35:03.000Z"],
    ],
  );
});

test("PUMP 的零数量被识别成字母 O、止盈文字损坏时仍按方向和比较符恢复", () => {
  const words = ocrRow({
    y: 420,
    date: "(026-07-16",
    time: "16:30:46",
    symbol: "PUMPUSDT",
    closeSide: "平多",
    kind: "市价止僵",
    comparator: ">=",
    triggerPrice: "0.0016750",
    executionType: "市价",
    quantity: "O",
    asset: "PUMP",
    status: "已取消",
  });

  const orders = parseConditionOrdersFromOcrWords(words, IMAGE_WIDTH);

  assert.equal(orders.length, 1);
  assert.equal(orders[0].symbol, "PUMPUSDT");
  assert.equal(orders[0].kind, "takeProfit");
  assert.equal(orders[0].quantity, 0);
  assert.equal(orders[0].executionType, "market");
});

test("真实截图漏掉平仓方向时，按明确的止盈止损类型与比较符恢复方向", () => {
  const words = [
    ...ocrRow({
      y: 100,
      date: "2026-07-15",
      time: "15:50:53",
      symbol: "ZECUSDT",
      closeSide: "",
      kind: "市价止盈",
      comparator: "<=",
      triggerPrice: "558.18",
      executionType: "市价",
      quantity: "0.000",
      asset: "ZEC",
      status: "已取消",
    }),
    ...ocrRow({
      y: 180,
      date: "2026-07-16",
      time: "10:65:17",
      symbol: "ZECUSDT",
      closeSide: "",
      kind: "市价止盈止损",
      comparator: "<=",
      triggerPrice: "564.70",
      executionType: "市价",
      quantity: "0.000",
      asset: "ZEC",
      status: "已取消",
    }),
  ];

  const orders = parseConditionOrdersFromOcrWords(words, IMAGE_WIDTH);

  assert.deepEqual(
    orders.map((order) => ({
      createdTime: order.createdTime,
      closeSide: order.closeSide,
      kind: order.kind,
    })),
    [
      {
        createdTime: "2026-07-15T07:50:53.000Z",
        closeSide: "closeShort",
        kind: "takeProfit",
      },
      {
        createdTime: "2026-07-16T02:55:17.000Z",
        closeSide: "closeLong",
        kind: "stopLoss",
      },
    ],
  );
});

test("真实截图把止损识别成 HERI 且相邻止盈文字丢失时，沿用同币对近邻方向", () => {
  const words = [
    ...ocrRow({
      y: 100,
      date: "2026-07-16",
      time: "16:31:21",
      symbol: "PUMPUSDT",
      closeSide: "",
      kind: "HERI",
      comparator: "<=",
      triggerPrice: "0.0015900",
      executionType: "市价",
      quantity: "O",
      asset: "PUMP",
      status: "已过期",
    }),
    ...ocrRow({
      y: 180,
      date: "2026-07-16",
      time: "16:30:46",
      symbol: "PUMPUSDT",
      closeSide: "",
      kind: "",
      comparator: ">=",
      triggerPrice: "0.0016750",
      executionType: "市价",
      quantity: "O",
      asset: "PUMP",
      status: "已取消",
    }),
  ];

  const orders = parseConditionOrdersFromOcrWords(words, IMAGE_WIDTH);

  assert.deepEqual(
    orders.map((order) => [order.createdTime, order.closeSide, order.kind]),
    [
      ["2026-07-16T08:30:46.000Z", "closeLong", "takeProfit"],
      ["2026-07-16T08:31:21.000Z", "closeLong", "stopLoss"],
    ],
  );
});

test("条件单按交易对、方向和持仓时间段匹配，多笔同类记录形成动态风险区间", () => {
  const trades = [
    {
      id: "hype-first",
      symbol: "HYPEUSDT",
      side: "long",
      entryTime: "2026-07-16T06:00:00.000Z",
      exits: [
        {
          quantity: 22.88,
          exitPrice: 65.79,
          exitTime: "2026-07-16T08:04:17.000Z",
        },
      ],
      riskLevels: [
        {
          id: "existing-tp",
          kind: "takeProfit",
          price: 67.179,
          startTime: "2026-07-16T07:00:00.000Z",
          endTime: "2026-07-16T08:04:17.000Z",
          endState: "expired",
        },
      ],
    },
    {
      id: "hype-second",
      symbol: "HYPEUSDT",
      side: "long",
      entryTime: "2026-07-16T09:00:00.000Z",
      exitTime: "2026-07-16T10:00:00.000Z",
    },
    {
      id: "pump-long",
      symbol: "PUMPUSDT",
      side: "long",
      entryTime: "2026-07-16T12:00:00.000Z",
      exitTime: "2026-07-16T14:00:00.000Z",
    },
    {
      id: "zec-short",
      symbol: "ZECUSDT",
      side: "short",
      entryTime: "2026-07-16T01:00:00.000Z",
      exitTime: "2026-07-16T05:00:00.000Z",
    },
  ];
  const firstHypeStop = conditionOrder({
    id: "ocr-condition-hype-stop-1",
    createdTime: "2026-07-16T07:35:25.000Z",
    status: "filled",
  });
  const orders = [
    firstHypeStop,
    { ...firstHypeStop, status: "cancelled" },
    conditionOrder({
      id: "ocr-condition-hype-stop-2",
      createdTime: "2026-07-16T07:50:00.000Z",
      triggerPrice: 65.5,
      status: "filled",
    }),
    conditionOrder({
      id: "ocr-condition-hype-later",
      createdTime: "2026-07-16T09:30:00.000Z",
      triggerPrice: 64.9,
      status: "expired",
    }),
    conditionOrder({
      id: "ocr-condition-pump-tp",
      symbol: "PUMPUSDT",
      asset: "PUMP",
      createdTime: "2026-07-16T13:00:00.000Z",
      kind: "takeProfit",
      triggerPrice: 0.00165,
      quantity: 1_007_485,
      status: "filled",
    }),
    conditionOrder({
      id: "ocr-condition-zec-sl",
      symbol: "ZECUSDT",
      asset: "ZEC",
      closeSide: "closeShort",
      createdTime: "2026-07-16T03:00:00.000Z",
      triggerPrice: 570,
      quantity: 2.5,
      executionType: "limit",
      status: "cancelled",
    }),
    conditionOrder({
      id: "ocr-condition-wrong-side",
      closeSide: "closeShort",
      createdTime: "2026-07-16T07:40:00.000Z",
    }),
  ];

  const attached = attachConditionOrdersToTrades(trades, orders);
  assert.equal(attached[0].riskLevels.length, 3);
  assert.deepEqual(attached[0].riskLevels.slice(1), [
    {
      id: "ocr-risk-ocr-condition-hype-stop-1",
      kind: "stopLoss",
      price: 65.2,
      startTime: "2026-07-16T07:35:25.000Z",
      endTime: "2026-07-16T07:50:00.000Z",
      endState: "cancelled",
      executionType: "market",
      source: "ocr",
      ocrStatus: "cancelled",
      comparator: "<=",
      quantity: 22.88,
      asset: "HYPE",
      confidence: 94,
      rawText: "HYPE 条件单",
    },
    {
      id: "ocr-risk-ocr-condition-hype-stop-2",
      kind: "stopLoss",
      price: 65.5,
      startTime: "2026-07-16T07:50:00.000Z",
      endTime: "2026-07-16T08:04:17.000Z",
      endState: "filled",
      executionType: "market",
      source: "ocr",
      ocrStatus: "filled",
      comparator: "<=",
      quantity: 22.88,
      asset: "HYPE",
      confidence: 94,
      rawText: "HYPE 条件单",
    },
  ]);
  assert.equal(attached[1].riskLevels.length, 1);
  assert.equal(attached[1].riskLevels[0].id, "ocr-risk-ocr-condition-hype-later");
  assert.equal(attached[1].riskLevels[0].endState, "expired");
  assert.equal(attached[2].riskLevels[0].kind, "takeProfit");
  assert.equal(attached[3].riskLevels[0].closeSide, undefined);
  assert.equal(attached[3].riskLevels[0].executionType, "limit");
  assert.equal(attached[3].riskLevels[0].endState, "cancelled");

  const repeated = attachConditionOrdersToTrades(attached, orders);
  assert.deepEqual(
    repeated.map((trade) => trade.riskLevels?.map((level) => level.id)),
    attached.map((trade) => trade.riskLevels?.map((level) => level.id)),
  );

  const incrementalFirst = attachConditionOrdersToTrades(trades, [firstHypeStop]);
  const incrementalSecond = attachConditionOrdersToTrades(incrementalFirst, [
    conditionOrder({
      id: "ocr-condition-hype-stop-2",
      createdTime: "2026-07-16T07:50:00.000Z",
      triggerPrice: 65.5,
      status: "filled",
    }),
  ]);
  assert.equal(
    incrementalSecond[0].riskLevels.find(
      (level) => level.id === "ocr-risk-ocr-condition-hype-stop-1",
    ).endTime,
    "2026-07-16T07:50:00.000Z",
  );
});

test("首次添加 OCR 条件单时保留旧交易的静态 TP/SL，并在同类条件变化时结束旧线", () => {
  const trade = {
    id: "legacy-hype",
    symbol: "HYPEUSDT",
    side: "long",
    entryTime: "2026-07-16T06:00:00.000Z",
    exitTime: "2026-07-16T08:00:00.000Z",
    takeProfit: 67.2,
    stopLoss: 64.5,
  };
  const stopOrder = conditionOrder({
    createdTime: "2026-07-16T07:00:00.000Z",
    triggerPrice: 65.2,
  });

  const [attached] = attachConditionOrdersToTrades([trade], [stopOrder]);

  assert.deepEqual(Object.fromEntries(attached.riskLevels.map((level) => [
    level.id,
    [level.kind, level.endTime],
  ])), {
    "legacy-static-take-profit": ["takeProfit", "2026-07-16T08:00:00.000Z"],
    "legacy-static-stop-loss": ["stopLoss", "2026-07-16T07:00:00.000Z"],
    "ocr-risk-ocr-condition-default": ["stopLoss", "2026-07-16T08:00:00.000Z"],
  });
});

test("交易区间外、方向不符或没有最终平仓时间的条件单不会错误挂接", () => {
  const trades = [
    {
      id: "open-hype",
      symbol: "HYPEUSDT",
      side: "long",
      entryTime: "2026-07-16T06:00:00.000Z",
      exits: [],
    },
    {
      id: "closed-hype",
      symbol: "HYPEUSDT",
      side: "long",
      entryTime: "2026-07-16T08:00:00.000Z",
      exitTime: "2026-07-16T09:00:00.000Z",
    },
  ];

  const result = attachConditionOrdersToTrades(trades, [
    conditionOrder({ createdTime: "2026-07-16T07:00:00.000Z" }),
    conditionOrder({
      id: "wrong-direction",
      createdTime: "2026-07-16T08:30:00.000Z",
      closeSide: "closeShort",
    }),
  ]);

  assert.equal(result[0].riskLevels, undefined);
  assert.equal(result[1].riskLevels, undefined);
});
