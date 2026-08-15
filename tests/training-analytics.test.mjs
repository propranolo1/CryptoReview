import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTrainingSessionSummary,
  calculateTrainingAnalyticsPerformance,
  calculateTrainingRiskExpectation,
} from "../lib/training-analytics.mjs";

function position(quantity = 10) {
  return {
    side: "long",
    quantity,
    averagePrice: 100,
    margin: quantity * 100,
  };
}

function location(candleIndex) {
  const time = 1_700_000_000 + candleIndex * 900;
  return {
    interval: "15m",
    candleOpenTimeMs: time * 1_000,
    candleCloseTimeMs: (time + 899) * 1_000 + 999,
    candleIndex,
    revealedOffset: candleIndex,
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    timing: "candle-close",
  };
}

function action({
  id,
  sequence,
  type,
  side,
  price,
  quantity,
  before,
  after,
  realizedPnl = 0,
  totalRealizedPnl = 0,
  candleIndex,
}) {
  return {
    actionId: id,
    sequence,
    operationSequence: sequence,
    type,
    side,
    price,
    quantity,
    margin: quantity * price,
    capitalRatio: null,
    positionRatio: null,
    realizedPnl,
    totalRealizedPnl,
    positionBefore: before,
    positionAfter: after,
    unrealizedPnlAfter: 0,
    equityAfter: 10_000 + totalRealizedPnl,
    availableCapitalAfter: 10_000 + totalRealizedPnl,
    marketLocation: location(candleIndex),
  };
}

function candle(index, high, low, close = 100) {
  const time = 1_700_000_000 + index * 900;
  return {
    time,
    open: 100,
    high,
    low,
    close,
    volume: 10,
    closeTime: (time + 899) * 1_000 + 999,
  };
}

test("TP/SL 预期结果按触发仓位比例计算盈亏、收益率和盈亏比", () => {
  const expectation = calculateTrainingRiskExpectation({
    startingCapital: 1_000,
    position: {
      side: "long",
      quantity: 2,
      averagePrice: 100,
      margin: 200,
    },
    risk: {
      takeProfit: 110,
      takeProfitRatio: 0.5,
      stopLoss: 90,
      stopLossRatio: 0.25,
      updatedAt: "2026-07-16T08:00:00.000Z",
    },
  });

  assert.deepEqual(expectation.takeProfit, {
    price: 110,
    positionRatio: 0.5,
    quantity: 1,
    pnl: 10,
    returnRatePercent: 1,
    distancePercent: 10,
  });
  assert.deepEqual(expectation.stopLoss, {
    price: 90,
    positionRatio: 0.25,
    quantity: 0.5,
    pnl: -5,
    returnRatePercent: -0.5,
    distancePercent: -10,
  });
  assert.equal(expectation.rewardRiskRatio, 2);
});

test("训练结束摘要计算 R、MFE、MAE、持仓 K 线和加减仓次数", () => {
  const actions = [
    action({
      id: "open",
      sequence: 1,
      type: "open",
      side: "long",
      price: 100,
      quantity: 10,
      before: null,
      after: position(10),
      candleIndex: 1,
    }),
    action({
      id: "add",
      sequence: 3,
      type: "add",
      side: "long",
      price: 100,
      quantity: 10,
      before: position(10),
      after: position(20),
      candleIndex: 2,
    }),
    action({
      id: "reduce",
      sequence: 4,
      type: "reduce",
      side: "long",
      price: 110,
      quantity: 10,
      before: position(20),
      after: position(10),
      realizedPnl: 100,
      totalRealizedPnl: 100,
      candleIndex: 4,
    }),
    action({
      id: "close",
      sequence: 5,
      type: "close",
      side: "long",
      price: 105,
      quantity: 10,
      before: position(10),
      after: null,
      realizedPnl: 50,
      totalRealizedPnl: 150,
      candleIndex: 6,
    }),
  ];
  const result = {
    id: "summary-1",
    startingCapital: 10_000,
    netPnl: 150,
    returnRatePercent: 1.5,
    actions,
    riskChanges: [{
      riskChangeId: "risk-1",
      sequence: 1,
      operationSequence: 2,
      position: position(10),
      after: {
        takeProfit: null,
        stopLoss: 90,
        updatedAt: "2026-07-16T08:01:00.000Z",
      },
    }],
  };
  const candles = [
    candle(0, 101, 99),
    candle(1, 105, 98),
    candle(2, 108, 95),
    candle(3, 120, 98),
    candle(4, 115, 100, 110),
    candle(5, 112, 90, 105),
    candle(6, 108, 100, 105),
  ];

  const summary = buildTrainingSessionSummary({
    result,
    candles,
    mainTimeframe: "15m",
  });

  assert.equal(summary.netPnl, 150);
  assert.equal(summary.returnRatePercent, 1.5);
  assert.equal(summary.initialRisk, 100);
  assert.equal(summary.rMultiple, 1.5);
  assert.equal(summary.mfe, 400);
  assert.equal(summary.mae, -50);
  assert.equal(summary.averageHoldingBars, 5);
  assert.equal(summary.averageHoldingMs, 75 * 60 * 1_000);
  assert.equal(summary.addCount, 1);
  assert.equal(summary.reduceCount, 1);
  assert.equal(summary.direction, "long");
  assert.equal(summary.mainTimeframe, "15m");
});

test("没有为每个持仓周期建立初始止损时不伪造 R 倍数", () => {
  const result = {
    id: "summary-no-risk",
    startingCapital: 10_000,
    netPnl: 50,
    returnRatePercent: 0.5,
    actions: [
      action({
        id: "open",
        sequence: 1,
        type: "open",
        side: "long",
        price: 100,
        quantity: 10,
        before: null,
        after: position(10),
        candleIndex: 1,
      }),
      action({
        id: "close",
        sequence: 2,
        type: "close",
        side: "long",
        price: 105,
        quantity: 10,
        before: position(10),
        after: null,
        realizedPnl: 50,
        totalRealizedPnl: 50,
        candleIndex: 2,
      }),
    ],
    riskChanges: [],
  };
  const summary = buildTrainingSessionSummary({
    result,
    candles: [candle(0, 101, 99), candle(1, 105, 98), candle(2, 106, 100)],
    mainTimeframe: "1H",
  });

  assert.equal(summary.initialRisk, null);
  assert.equal(summary.rMultiple, null);
});

test("训练表现汇总平均 R、最大回撤、连胜连亏、持仓时间和分组胜率", () => {
  const records = [
    {
      id: "idle",
      endedAt: "2026-07-16T00:30:00.000Z",
      netPnl: 0,
      actions: [],
      summary: {
        rMultiple: null,
        mae: 0,
        averageHoldingMs: 0,
        holdingCycleCount: 0,
        direction: null,
        mainTimeframe: "15m",
      },
    },
    {
      id: "a",
      endedAt: "2026-07-16T01:00:00.000Z",
      netPnl: 100,
      summary: {
        rMultiple: 1,
        mae: -50,
        averageHoldingMs: 60 * 60 * 1_000,
        direction: "long",
        mainTimeframe: "15m",
      },
    },
    {
      id: "b",
      endedAt: "2026-07-16T02:00:00.000Z",
      netPnl: -50,
      summary: {
        rMultiple: -0.5,
        mae: -100,
        averageHoldingMs: 120 * 60 * 1_000,
        direction: "short",
        mainTimeframe: "1H",
      },
    },
    {
      id: "c",
      endedAt: "2026-07-16T03:00:00.000Z",
      netPnl: -25,
      summary: {
        rMultiple: -0.25,
        mae: -60,
        averageHoldingMs: 30 * 60 * 1_000,
        direction: "short",
        mainTimeframe: "1H",
      },
    },
    {
      id: "d",
      endedAt: "2026-07-16T04:00:00.000Z",
      netPnl: 80,
      summary: {
        rMultiple: 0.8,
        mae: -40,
        averageHoldingMs: 90 * 60 * 1_000,
        direction: "long",
        mainTimeframe: "4H",
      },
    },
  ];

  const performance = calculateTrainingAnalyticsPerformance(records);
  assert.equal(performance.averageR, 0.2625);
  assert.equal(performance.rSampleSize, 4);
  assert.equal(performance.maxDrawdown, 75);
  assert.equal(performance.maxConsecutiveWins, 1);
  assert.equal(performance.maxConsecutiveLosses, 2);
  assert.equal(performance.averageHoldingMs, 75 * 60 * 1_000);
  assert.equal(performance.averageMae, 62.5);
  assert.deepEqual(performance.directionStats.long, {
    sessions: 2,
    wins: 2,
    losses: 0,
    winRate: 100,
    totalPnl: 180,
    averageR: 0.9,
  });
  assert.deepEqual(performance.directionStats.short, {
    sessions: 2,
    wins: 0,
    losses: 2,
    winRate: 0,
    totalPnl: -75,
    averageR: -0.375,
  });
  assert.equal(performance.timeframeStats["1H"].sessions, 2);
  assert.equal(performance.timeframeStats["1H"].totalPnl, -75);
  assert.equal(performance.timeframeStats["1H"].winRate, 0);
});
