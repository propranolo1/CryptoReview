import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePositionPnl,
  calculateTradePnl,
  parseTrades,
} from "../lib/trade.mjs";

test("多仓与空仓使用相反的价格方向计算盈亏", () => {
  assert.equal(
    calculatePositionPnl({
      side: "long",
      entryPrice: 100,
      price: 112,
      quantity: 2,
    }),
    24,
  );
  assert.equal(
    calculatePositionPnl({
      side: "short",
      entryPrice: 100,
      price: 112,
      quantity: 2,
    }),
    -24,
  );
});

test("分批退出逐笔计算已实现盈亏，剩余仓位按当前回放价计算未实现盈亏", () => {
  const result = calculateTradePnl(
    {
      side: "long",
      quantity: 10,
      entryPrice: 100,
      fee: 2,
      exits: [
        { quantity: 3, exitPrice: 110, fee: 1 },
        { quantity: 2, exitPrice: 90, fee: 0.5 },
      ],
    },
    120,
  );

  assert.deepEqual(result, {
    entryNotional: 1000,
    exitedQuantity: 5,
    remainingQuantity: 5,
    realizedPnl: 7.5,
    unrealizedPnl: 99,
    totalPnl: 106.5,
    returnRate: 0.1065,
    returnRatePercent: 10.65,
  });
});

test("空仓部分退出盈利但剩余仓位可产生未实现亏损", () => {
  const result = calculateTradePnl(
    {
      side: "short",
      quantity: 4,
      entryPrice: 200,
      exits: [{ quantity: 1, exitPrice: 180 }],
    },
    220,
  );

  assert.equal(result.realizedPnl, 20);
  assert.equal(result.unrealizedPnl, -60);
  assert.equal(result.totalPnl, -40);
  assert.equal(result.returnRate, -0.05);
  assert.equal(result.returnRatePercent, -5);
});

test("完全平仓时可直接使用顶层平仓价且不要求当前回放价", () => {
  const result = calculateTradePnl({
    side: "long",
    quantity: 2,
    entryPrice: 100,
    exitPrice: 125,
    exitTime: "2026-07-02T08:00:00Z",
    fee: 3,
  });

  assert.equal(result.exitedQuantity, 2);
  assert.equal(result.remainingQuantity, 0);
  assert.equal(result.realizedPnl, 47);
  assert.equal(result.unrealizedPnl, 0);
  assert.equal(result.returnRate, 0.235);
});

test("CSV 导入支持英文字段并返回统一交易结构", () => {
  const csv = [
    "symbol,side,quantity,entryPrice,entryTime,stopLoss,takeProfit,exitPrice,exitTime,fee",
    '"BTC,USDT",LONG,2,60000,2026-07-01T08:00:00Z,58000,65000,63000,2026-07-02T08:00:00Z,12.5',
  ].join("\n");

  assert.deepEqual(parseTrades(csv, "csv"), [
    {
      symbol: "BTC,USDT",
      side: "long",
      quantity: 2,
      entryPrice: 60000,
      entryTime: "2026-07-01T08:00:00Z",
      stopLoss: 58000,
      takeProfit: 65000,
      exitPrice: 63000,
      exitTime: "2026-07-02T08:00:00Z",
      fee: 12.5,
      exits: [
        {
          quantity: 2,
          exitPrice: 63000,
          exitTime: "2026-07-02T08:00:00Z",
          fee: 0,
        },
      ],
    },
  ]);
});

test("CSV 导入支持中文字段、中文方向与空可选值", () => {
  const csv = [
    "\uFEFF交易对,方向,数量,开仓价,开仓时间,止损,止盈,平仓价,平仓时间,手续费",
    "ETH/USDT,空,1.5,3200,2026-07-03 10:30:00,,3000,,,4",
  ].join("\r\n");

  assert.deepEqual(parseTrades(csv), [
    {
      symbol: "ETH/USDT",
      side: "short",
      quantity: 1.5,
      entryPrice: 3200,
      entryTime: "2026-07-03 10:30:00",
      stopLoss: null,
      takeProfit: 3000,
      exitPrice: null,
      exitTime: null,
      fee: 4,
      exits: [],
    },
  ]);
});

test("JSON 导入支持字段别名和多笔退出成交", () => {
  const json = JSON.stringify([
    {
      交易对: "SOL/USDT",
      方向: "做多",
      数量: "5",
      开仓价: "140",
      开仓时间: "2026-07-04T00:00:00Z",
      止损: "130",
      止盈: "165",
      手续费: "1.2",
      exits: [
        {
          数量: "2",
          平仓价: "150",
          平仓时间: "2026-07-04T04:00:00Z",
          手续费: "0.3",
        },
        {
          quantity: 1,
          exitPrice: 155,
          exitTime: "2026-07-04T05:00:00Z",
          fee: 0.2,
        },
      ],
    },
  ]);

  const [trade] = parseTrades(json);
  assert.deepEqual(trade, {
    symbol: "SOL/USDT",
    side: "long",
    quantity: 5,
    entryPrice: 140,
    entryTime: "2026-07-04T00:00:00Z",
    stopLoss: 130,
    takeProfit: 165,
    exitPrice: null,
    exitTime: null,
    fee: 1.2,
    exits: [
      {
        quantity: 2,
        exitPrice: 150,
        exitTime: "2026-07-04T04:00:00Z",
        fee: 0.3,
      },
      {
        quantity: 1,
        exitPrice: 155,
        exitTime: "2026-07-04T05:00:00Z",
        fee: 0.2,
      },
    ],
  });

  assert.equal(calculateTradePnl(trade, 145).realizedPnl, 33.78);
});

test("JSON 可直接传入对象数组，非法方向会给出明确错误", () => {
  const [trade] = parseTrades([
    {
      symbol: "BTC/USDT",
      side: "sell",
      quantity: 1,
      entryPrice: 100,
      entryTime: "2026-07-01",
    },
  ]);

  assert.equal(trade.side, "short");
  assert.throws(
    () =>
      parseTrades([
        {
          symbol: "BTC/USDT",
          side: "观望",
          quantity: 1,
          entryPrice: 100,
        },
      ]),
    /第 1 笔交易的方向无效/,
  );
});
