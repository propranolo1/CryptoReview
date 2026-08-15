import assert from "node:assert/strict";
import test from "node:test";

import {
  getReplayPriceLines,
  getRiskLevelReplayState,
} from "../lib/risk.mjs";

const trade = {
  entryPrice: 66.431,
  takeProfit: null,
  stopLoss: null,
  riskLevels: [
    {
      id: "tp-10908281928",
      orderId: "10908281928",
      kind: "takeProfit",
      inferred: true,
      price: 67.179,
      startTime: "2026-07-16T07:35:25.000Z",
      endTime: "2026-07-16T08:04:17.000Z",
      endState: "expired",
    },
  ],
};

test("成本线始终显示，止盈挂单只在有效时间窗内显示", () => {
  assert.deepEqual(
    getReplayPriceLines(trade, Date.parse("2026-07-16T07:35:24.999Z")),
    [{ id: "cost", kind: "cost", price: 66.431, label: "成本" }],
  );

  assert.deepEqual(
    getReplayPriceLines(trade, Date.parse("2026-07-16T07:35:25.000Z")),
    [
      { id: "cost", kind: "cost", price: 66.431, label: "成本" },
      {
        id: "tp-10908281928",
        kind: "takeProfit",
        price: 67.179,
        label: "TP",
        inferred: true,
      },
    ],
  );

  assert.equal(
    getReplayPriceLines(trade, Date.parse("2026-07-16T08:04:16.999Z")).length,
    2,
  );
  assert.deepEqual(
    getReplayPriceLines(trade, Date.parse("2026-07-16T08:04:17.000Z")),
    [{ id: "cost", kind: "cost", price: 66.431, label: "成本" }],
  );
});

test("动态风险线继承明确的 inferred 元数据，价格线固定显示 TP", () => {
  const lines = getReplayPriceLines(
    {
      entryPrice: 100,
      riskLevels: [
        {
          id: "confirmed-tp",
          kind: "takeProfit",
          inferred: false,
          price: 110,
          startTime: "2026-07-16T07:00:00.000Z",
          endTime: null,
        },
      ],
    },
    Date.parse("2026-07-16T08:00:00.000Z"),
  );

  assert.deepEqual(lines[1], {
    id: "confirmed-tp",
    kind: "takeProfit",
    price: 110,
    label: "TP",
    inferred: false,
  });
});

test("OCR 风险线在 TP/SL 标签后显示 MARKET 或 LIMIT 执行方式", () => {
  const lines = getReplayPriceLines(
    {
      entryPrice: 100,
      riskLevels: [
        {
          id: "ocr-tp-market",
          kind: "takeProfit",
          price: 112,
          startTime: "2026-07-16T07:00:00.000Z",
          endTime: null,
          executionType: "market",
          source: "ocr",
          ocrStatus: "filled",
        },
        {
          id: "ocr-sl-limit",
          kind: "stopLoss",
          price: 94,
          startTime: "2026-07-16T07:00:00.000Z",
          endTime: null,
          executionType: "limit",
          source: "ocr",
          ocrStatus: "cancelled",
        },
      ],
    },
    Date.parse("2026-07-16T08:00:00.000Z"),
  );

  assert.deepEqual(lines, [
    { id: "cost", kind: "cost", price: 100, label: "成本" },
    {
      id: "ocr-tp-market",
      kind: "takeProfit",
      price: 112,
      label: "TP · MARKET",
    },
    {
      id: "ocr-sl-limit",
      kind: "stopLoss",
      price: 94,
      label: "SL · LIMIT",
    },
  ]);
});

test("拖回挂单区间时止盈线会重新出现，且不会推导不存在的止损线", () => {
  const afterExpiry = getReplayPriceLines(
    trade,
    Date.parse("2026-07-16T08:04:18.000Z"),
  );
  const rewound = getReplayPriceLines(
    trade,
    Date.parse("2026-07-16T07:50:00.000Z"),
  );

  assert.equal(afterExpiry.some((line) => line.kind === "stopLoss"), false);
  assert.equal(afterExpiry.some((line) => line.kind === "takeProfit"), false);
  assert.equal(rewound.some((line) => line.kind === "takeProfit"), true);
  assert.equal(rewound.some((line) => line.kind === "stopLoss"), false);
});

test("旧交易没有风险历史时继续兼容静态止盈止损", () => {
  const lines = getReplayPriceLines(
    { entryPrice: 100, takeProfit: 110, stopLoss: 95 },
    Date.parse("2026-07-16T08:00:00.000Z"),
  );

  assert.deepEqual(lines, [
    { id: "cost", kind: "cost", price: 100, label: "成本" },
    { id: "static-take-profit", kind: "takeProfit", price: 110, label: "TP" },
    { id: "static-stop-loss", kind: "stopLoss", price: 95, label: "SL" },
  ]);
  assert.deepEqual(
    getReplayPriceLines(
      { entryPrice: 100, takeProfit: 110, stopLoss: 95, riskLevels: [] },
      Date.parse("2026-07-16T08:00:00.000Z"),
    ),
    [{ id: "cost", kind: "cost", price: 100, label: "成本" }],
  );
});

test("挂单状态采用开始包含、结束不包含的边界", () => {
  const level = trade.riskLevels[0];

  assert.equal(
    getRiskLevelReplayState(level, Date.parse("2026-07-16T07:35:24.999Z")),
    "pending",
  );
  assert.equal(
    getRiskLevelReplayState(level, Date.parse("2026-07-16T07:35:25.000Z")),
    "active",
  );
  assert.equal(
    getRiskLevelReplayState(level, Date.parse("2026-07-16T08:04:17.000Z")),
    "expired",
  );
});
