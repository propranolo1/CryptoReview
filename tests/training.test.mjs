import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTrainingAction,
  calculateTrainingPerformance,
  canStartNewTrainingRound,
  cancelTrainingLimitOrder,
  createTrainingSession,
  finishTrainingSession,
  getTrainingAccountSnapshot,
  placeTrainingLimitOrder,
  processTrainingCandle,
  setTrainingRiskLevels,
} from "../lib/training.mjs";

function session(overrides = {}) {
  return createTrainingSession({
    id: "training-default",
    startingCapital: 1_000,
    leverage: 2,
    startedAt: "2026-07-16T08:00:00.000Z",
    ...overrides,
  });
}

function act(currentSession, action) {
  return applyTrainingAction(currentSession, {
    time: "2026-07-16T08:01:00.000Z",
    ...action,
  });
}

test("创建 BTC U 本位训练会话并严格校验初始金额、杠杆与交易对", () => {
  assert.deepEqual(session(), {
    id: "training-default",
    symbol: "BTCUSDT",
    startingCapital: 1_000,
    leverage: 2,
    startedAt: "2026-07-16T08:00:00.000Z",
    status: "active",
    realizedPnl: 0,
    unrealizedPnl: 0,
    usedMargin: 0,
    availableCapital: 1_000,
    walletBalance: 1_000,
    equity: 1_000,
    markPrice: null,
    position: null,
    risk: null,
    actions: [],
    riskChanges: [],
    limitOrders: [],
    limitOrderChanges: [],
  });

  assert.equal(createTrainingSession({ id: "default", startedAt: 0 }).startingCapital, 10_000);
  assert.equal(createTrainingSession({ id: "default", startedAt: 0 }).leverage, 1);

  assert.throws(
    () => session({ startingCapital: 0 }),
    /初始资金必须大于 0/,
  );
  assert.throws(() => session({ leverage: 1.5 }), /杠杆必须是正整数/);
  assert.throws(() => session({ symbol: "ETHUSDT" }), /仅支持 BTCUSDT/);
  assert.throws(() => session({ startedAt: "错误时间" }), /开始时间无效/);
});

test("空仓且无挂单时可随时保存并开始新一局", () => {
  const flat = session();
  const positioned = act(flat, {
    type: "open",
    side: "long",
    price: 100,
    margin: 200,
  });
  const withLimitOrder = placeTrainingLimitOrder(flat, {
    side: "buy",
    price: 90,
    currentPrice: 100,
    ratio: 0.25,
    time: "2026-07-16T08:01:00.000Z",
  });

  assert.equal(canStartNewTrainingRound(null), true);
  assert.equal(canStartNewTrainingRound(flat), true);
  assert.equal(canStartNewTrainingRound(positioned), false);
  assert.equal(canStartNewTrainingRound(withLimitOrder), false);
});

test("多仓按保证金开仓、按可用资金比例加仓并更新加权成本", () => {
  const initial = session();
  const opened = act(initial, {
    type: "open",
    side: "long",
    price: 100,
    margin: 200,
  });
  const added = act(opened, {
    type: "add",
    price: 200,
    capitalRatio: 0.25,
    time: "2026-07-16T08:02:00.000Z",
  });

  // 纯函数不能改写调用方持有的旧状态。
  assert.equal(initial.position, null);
  assert.equal(opened.position.quantity, 4);
  assert.equal(opened.position.averagePrice, 100);
  assert.equal(opened.position.margin, 200);
  assert.equal(opened.availableCapital, 800);

  assert.equal(added.position.quantity, 7);
  assert.equal(added.position.averagePrice, 142.857142857143);
  assert.equal(added.position.margin, 500);
  assert.equal(added.unrealizedPnl, 400);
  assert.equal(added.equity, 1_400);
  assert.equal(added.availableCapital, 900);
  assert.deepEqual(
    added.actions.map((action) => ({
      type: action.type,
      quantity: action.quantity,
      margin: action.margin,
      capitalRatio: action.capitalRatio,
    })),
    [
      { type: "open", quantity: 4, margin: 200, capitalRatio: null },
      { type: "add", quantity: 3, margin: 300, capitalRatio: 0.25 },
    ],
  );
});

test("每笔仓位操作保存现实记录时间、历史 K 线位置和操作前后仓位", () => {
  const openLocation = {
    interval: "15m",
    candleOpenTimeMs: 1_700_000_000_000,
    candleCloseTimeMs: 1_700_000_899_999,
    candleIndex: 800,
    revealedOffset: 0,
    open: 100,
    high: 104,
    low: 99,
    close: 102,
    timing: "candle-close",
  };
  const closeLocation = {
    ...openLocation,
    candleOpenTimeMs: 1_700_000_900_000,
    candleCloseTimeMs: 1_700_001_799_999,
    candleIndex: 801,
    revealedOffset: 1,
    open: 102,
    high: 111,
    low: 101,
    close: 110,
  };
  let current = applyTrainingAction(session(), {
    type: "open",
    side: "long",
    price: 102,
    margin: 200,
    time: "2026-07-16T08:01:00.000Z",
    marketLocation: openLocation,
  });
  current = applyTrainingAction(current, {
    type: "close",
    price: 110,
    time: "2026-07-16T08:02:00.000Z",
    marketLocation: closeLocation,
  });

  const [opened, closed] = current.actions;
  assert.equal(opened.actionId, "training-default-action-1");
  assert.equal(opened.recordedAt, "2026-07-16T08:01:00.000Z");
  assert.deepEqual(opened.marketLocation, openLocation);
  assert.deepEqual(opened.positionBefore, null);
  assert.deepEqual(opened.positionAfter, {
    side: "long",
    quantity: 3.921568627451,
    averagePrice: 102,
    margin: 200,
  });
  assert.equal(opened.quantity, 3.921568627451);
  assert.equal(opened.margin, 200);
  assert.equal(opened.riskBefore, null);
  assert.equal(opened.riskAfter, null);

  assert.equal(closed.actionId, "training-default-action-2");
  assert.equal(closed.recordedAt, "2026-07-16T08:02:00.000Z");
  assert.deepEqual(closed.marketLocation, closeLocation);
  assert.deepEqual(closed.positionBefore, opened.positionAfter);
  assert.equal(closed.positionAfter, null);
  assert.equal(closed.quantity, opened.positionAfter.quantity);
  assert.equal(closed.margin, 200);
  assert.equal(closed.realizedPnl, 31.37254902);

  const result = finishTrainingSession(current, {
    endedAt: "2026-07-16T08:03:00.000Z",
  });
  assert.deepEqual(result.actions, current.actions);
});

test("设置、修改和清除 TP/SL 均保存所在 K 线及修改前后状态", () => {
  const location = {
    interval: "15m",
    candleOpenTimeMs: 1_700_000_000_000,
    candleCloseTimeMs: 1_700_000_899_999,
    candleIndex: 800,
    revealedOffset: 0,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    timing: "candle-close",
  };
  let current = act(session(), {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
    marketLocation: location,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: 110,
    stopLoss: 90,
    time: "2026-07-16T08:02:00.000Z",
    source: "input",
    marketLocation: location,
  });
  current = setTrainingRiskLevels(current, {
    stopLoss: 95,
    time: "2026-07-16T08:03:00.000Z",
    source: "drag",
    marketLocation: location,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: null,
    stopLoss: null,
    time: "2026-07-16T08:04:00.000Z",
    source: "input",
    marketLocation: location,
  });

  assert.equal(current.risk, null);
  assert.equal(current.riskChanges.length, 3);
  assert.deepEqual(
    current.riskChanges.map((change) => ({
      riskChangeId: change.riskChangeId,
      source: change.source,
      before: change.before,
      after: change.after,
      marketLocation: change.marketLocation,
    })),
    [
      {
        riskChangeId: "training-default-risk-1",
        source: "input",
        before: null,
        after: {
          takeProfit: 110,
          stopLoss: 90,
          updatedAt: "2026-07-16T08:02:00.000Z",
        },
        marketLocation: location,
      },
      {
        riskChangeId: "training-default-risk-2",
        source: "drag",
        before: {
          takeProfit: 110,
          stopLoss: 90,
          updatedAt: "2026-07-16T08:02:00.000Z",
        },
        after: {
          takeProfit: 110,
          stopLoss: 95,
          updatedAt: "2026-07-16T08:03:00.000Z",
        },
        marketLocation: location,
      },
      {
        riskChangeId: "training-default-risk-3",
        source: "input",
        before: {
          takeProfit: 110,
          stopLoss: 95,
          updatedAt: "2026-07-16T08:03:00.000Z",
        },
        after: null,
        marketLocation: location,
      },
    ],
  );
});

test("多仓按持仓比例减仓产生已实现盈亏，随后可全部平仓", () => {
  let current = session();
  current = act(current, {
    type: "open",
    side: "long",
    price: 100,
    margin: 200,
  });
  current = act(current, {
    type: "add",
    price: 200,
    margin: 200,
    time: "2026-07-16T08:02:00.000Z",
  });
  current = act(current, {
    type: "reduce",
    price: 150,
    positionRatio: 0.5,
    time: "2026-07-16T08:03:00.000Z",
  });

  assert.equal(current.realizedPnl, 50);
  assert.equal(current.position.quantity, 3);
  assert.equal(current.position.averagePrice, 133.333333333333);
  assert.equal(current.position.margin, 200);
  assert.equal(current.unrealizedPnl, 50);
  assert.equal(current.equity, 1_100);
  assert.equal(current.availableCapital, 900);
  assert.equal(current.actions.at(-1).realizedPnl, 50);

  current = act(current, {
    type: "close",
    price: 120,
    time: "2026-07-16T08:04:00.000Z",
  });
  assert.equal(current.position, null);
  assert.equal(current.usedMargin, 0);
  assert.equal(current.realizedPnl, 10);
  assert.equal(current.availableCapital, 1_010);
});

test("账户快照按当前 BTC 价格计算未实现盈亏、权益和可用资金", () => {
  let current = session();
  current = act(current, {
    type: "open",
    side: "long",
    price: 100,
    margin: 200,
  });

  assert.deepEqual(getTrainingAccountSnapshot(current, 125), {
    markPrice: 125,
    walletBalance: 1_000,
    realizedPnl: 0,
    unrealizedPnl: 100,
    equity: 1_100,
    usedMargin: 200,
    availableCapital: 900,
  });
  assert.equal(current.markPrice, 100);
  assert.equal(current.unrealizedPnl, 0);
});

test("空仓支持按 BTC 数量开仓、分批买入平仓和全部平仓", () => {
  let current = session({ leverage: 2 });
  current = act(current, {
    type: "open",
    side: "short",
    price: 200,
    quantity: 1,
  });
  assert.equal(current.position.margin, 100);

  current = act(current, {
    type: "reduce",
    price: 160,
    positionRatio: 0.25,
    time: "2026-07-16T08:02:00.000Z",
  });
  assert.equal(current.realizedPnl, 10);
  assert.equal(current.position.quantity, 0.75);

  current = act(current, {
    type: "close",
    price: 220,
    time: "2026-07-16T08:03:00.000Z",
  });
  assert.equal(current.realizedPnl, -5);
  assert.equal(current.availableCapital, 995);
});

test("仓位操作拒绝无效金额、数量、比例、顺序和超额交易", () => {
  const initial = session();
  assert.throws(
    () => act(initial, { type: "open", side: "long", price: 100 }),
    /必须且只能提供一种开仓规模/,
  );
  assert.throws(
    () =>
      act(initial, {
        type: "open",
        side: "long",
        price: 100,
        margin: 100,
        quantity: 1,
      }),
    /必须且只能提供一种开仓规模/,
  );
  assert.throws(
    () => act(initial, { type: "open", side: "long", price: 0, margin: 1 }),
    /成交价格必须大于 0/,
  );
  assert.throws(
    () => act(initial, { type: "add", price: 100, margin: 10 }),
    /当前没有可加仓的仓位/,
  );

  const opened = act(initial, {
    type: "open",
    side: "long",
    price: 100,
    margin: 200,
  });
  assert.throws(
    () => act(opened, { type: "open", side: "short", price: 100, margin: 10 }),
    /已有未平仓仓位/,
  );
  assert.throws(
    () => act(opened, { type: "add", price: 100, capitalRatio: 1.1 }),
    /资金比例必须大于 0 且不超过 1/,
  );
  assert.throws(
    () => act(opened, { type: "add", price: 100, margin: 801 }),
    /不能超过当前可用资金/,
  );
  assert.throws(
    () => act(opened, { type: "reduce", price: 100, quantity: 4 }),
    /部分平仓后必须保留仓位/,
  );
  assert.throws(
    () =>
      act(opened, {
        type: "reduce",
        price: 100,
        quantity: 1,
        positionRatio: 0.25,
      }),
    /必须且只能提供一种减仓规模/,
  );
  assert.throws(
    () =>
      act(opened, {
        type: "close",
        price: 100,
        time: "2026-07-16T07:59:00.000Z",
      }),
    /操作时间不能早于/,
  );
});

test("有持仓时禁止结束训练，必须先明确平仓再保存结果", () => {
  let current = session();
  current = act(current, {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
  });

  assert.throws(
    () =>
      finishTrainingSession(current, {
        endedAt: "2026-07-16T09:00:00.000Z",
        exitPrice: 125,
      }),
    /仍有未平仓仓位，必须先平仓/,
  );

  current = applyTrainingAction(current, {
    type: "close",
    price: 125,
    time: "2026-07-16T09:00:00.000Z",
  });
  const result = finishTrainingSession(current, {
    endedAt: "2026-07-16T09:00:01.000Z",
  });
  assert.equal(result.status, "finished");
  assert.equal(result.position, null);
  assert.equal(result.netPnl, 50);
  assert.equal(result.endingCapital, 1_050);
  assert.equal(result.returnRate, 0.05);
  assert.equal(result.returnRatePercent, 5);
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions.at(-1).type, "close");
  assert.equal(result.actions.at(-1).time, "2026-07-16T09:00:00.000Z");

  assert.throws(
    () => applyTrainingAction(result, { type: "close", price: 125 }),
    /已经结束/,
  );
});

test("多仓和空仓的 TP/SL 必须位于成本价正确一侧", () => {
  const long = act(session(), {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
  });
  const longWithRisk = setTrainingRiskLevels(long, {
    takeProfit: 110,
    stopLoss: 90,
    time: "2026-07-16T08:01:30.000Z",
  });
  assert.deepEqual(longWithRisk.risk, {
    takeProfit: 110,
    stopLoss: 90,
    updatedAt: "2026-07-16T08:01:30.000Z",
  });
  assert.equal(long.risk, null);
  assert.throws(
    () => setTrainingRiskLevels(long, {
      takeProfit: 100,
      time: "2026-07-16T08:01:30.000Z",
    }),
    /多仓止盈必须高于当前成本/,
  );
  assert.throws(
    () => setTrainingRiskLevels(long, {
      stopLoss: 100,
      time: "2026-07-16T08:01:30.000Z",
    }),
    /多仓止损必须低于当前成本/,
  );

  const short = act(session({ id: "training-short-risk" }), {
    type: "open",
    side: "short",
    price: 100,
    margin: 100,
  });
  assert.deepEqual(setTrainingRiskLevels(short, {
    takeProfit: 90,
    stopLoss: 110,
    time: "2026-07-16T08:01:30.000Z",
  }).risk, {
    takeProfit: 90,
    stopLoss: 110,
    updatedAt: "2026-07-16T08:01:30.000Z",
  });
  assert.throws(
    () => setTrainingRiskLevels(short, {
      takeProfit: 101,
      time: "2026-07-16T08:01:30.000Z",
    }),
    /空仓止盈必须低于当前成本/,
  );
  assert.throws(
    () => setTrainingRiskLevels(short, {
      stopLoss: 99,
      time: "2026-07-16T08:01:30.000Z",
    }),
    /空仓止损必须高于当前成本/,
  );
});

test("揭示下一根 K 线时按设定 TP 价格自动全部平仓并记录触发动作", () => {
  let current = act(session(), {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: 110,
    stopLoss: 90,
    time: "2026-07-16T08:01:30.000Z",
  });

  const noTrigger = processTrainingCandle(current, {
    time: 1_700_000_000,
    open: 100,
    high: 109,
    low: 91,
    close: 105,
    volume: 10,
    closeTime: 1_700_000_299_999,
  }, {
    time: "2026-07-16T08:02:00.000Z",
  });
  assert.equal(noTrigger.trigger, null);
  assert.equal(noTrigger.session.position.quantity, 2);
  assert.equal(noTrigger.session.markPrice, 105);
  assert.equal(noTrigger.session.unrealizedPnl, 10);

  const takeProfit = processTrainingCandle(noTrigger.session, {
    time: 1_700_000_300,
    open: 105,
    high: 112,
    low: 101,
    close: 106,
    volume: 12,
    closeTime: 1_700_000_599_999,
  }, {
    time: "2026-07-16T08:03:00.000Z",
    marketLocation: {
      interval: "15m",
      candleOpenTimeMs: 1_700_000_300_000,
      candleCloseTimeMs: 1_700_000_599_999,
      candleIndex: 801,
      revealedOffset: 1,
      open: 105,
      high: 112,
      low: 101,
      close: 106,
      timing: "intrabar-unknown",
    },
  });
  assert.deepEqual(takeProfit.trigger, {
    kind: "takeProfit",
    price: 110,
    time: "2026-07-16T08:03:00.000Z",
    candleTime: 1_700_000_300,
    side: "long",
  });
  assert.equal(takeProfit.session.position, null);
  assert.equal(takeProfit.session.risk, null);
  assert.equal(takeProfit.session.realizedPnl, 20);
  assert.equal(takeProfit.session.actions.at(-1).type, "close");
  assert.equal(takeProfit.session.actions.at(-1).price, 110);
  assert.equal(takeProfit.session.actions.at(-1).automatic, true);
  assert.equal(takeProfit.session.actions.at(-1).trigger, "takeProfit");
  assert.deepEqual(takeProfit.session.actions.at(-1).marketLocation, {
    interval: "15m",
    candleOpenTimeMs: 1_700_000_300_000,
    candleCloseTimeMs: 1_700_000_599_999,
    candleIndex: 801,
    revealedOffset: 1,
    open: 105,
    high: 112,
    low: 101,
    close: 106,
    timing: "intrabar-unknown",
  });
  assert.deepEqual(takeProfit.session.actions.at(-1).riskBefore, {
    takeProfit: 110,
    stopLoss: 90,
    updatedAt: "2026-07-16T08:01:30.000Z",
  });
  assert.equal(takeProfit.session.actions.at(-1).riskAfter, null);
});

test("保护性止盈只在价格回落穿过触发价时成交，不会在下一根 K 线直接误触发", () => {
  let current = act(session({ id: "training-protective-tp" }), {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: 110,
    currentPrice: 120,
    time: "2026-07-16T08:01:30.000Z",
  });

  assert.equal(current.risk.takeProfitTrigger, "below");

  const stillProtected = processTrainingCandle(current, {
    time: 1_700_000_000,
    open: 120,
    high: 125,
    low: 115,
    close: 123,
    volume: 10,
    closeTime: 1_700_000_299_999,
  }, {
    time: "2026-07-16T08:02:00.000Z",
  });
  assert.equal(stillProtected.trigger, null);
  assert.equal(stillProtected.session.position.side, "long");

  const protectedProfit = processTrainingCandle(stillProtected.session, {
    time: 1_700_000_300,
    open: 123,
    high: 124,
    low: 108,
    close: 109,
    volume: 12,
    closeTime: 1_700_000_599_999,
  }, {
    time: "2026-07-16T08:03:00.000Z",
  });
  assert.equal(protectedProfit.trigger.kind, "takeProfit");
  assert.equal(protectedProfit.trigger.price, 110);
  assert.equal(protectedProfit.session.position, null);
});

test("TP 和 SL 可分别按仓位比例触发，部分成交后撤掉已触发价格", () => {
  let current = act(session({ id: "training-partial-risk" }), {
    type: "open",
    side: "long",
    price: 100,
    quantity: 4,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: 110,
    takeProfitRatio: 0.5,
    stopLoss: 90,
    stopLossRatio: 0.25,
    time: "2026-07-16T08:01:30.000Z",
  });

  const takeProfit = processTrainingCandle(current, {
    time: 1_700_000_300,
    open: 105,
    high: 112,
    low: 101,
    close: 106,
  }, {
    time: "2026-07-16T08:02:00.000Z",
  });

  assert.equal(takeProfit.trigger.kind, "takeProfit");
  assert.equal(takeProfit.trigger.positionRatio, 0.5);
  assert.equal(takeProfit.trigger.fullyClosed, false);
  assert.equal(takeProfit.session.position.quantity, 2);
  assert.equal(takeProfit.session.actions.at(-1).type, "reduce");
  assert.equal(takeProfit.session.actions.at(-1).automatic, true);
  assert.deepEqual(takeProfit.session.risk, {
    takeProfit: null,
    stopLoss: 90,
    stopLossRatio: 0.25,
    updatedAt: "2026-07-16T08:02:00.000Z",
  });

  const stopLoss = processTrainingCandle(takeProfit.session, {
    time: 1_700_000_600,
    open: 95,
    high: 99,
    low: 88,
    close: 92,
  }, {
    time: "2026-07-16T08:03:00.000Z",
  });
  assert.equal(stopLoss.trigger.kind, "stopLoss");
  assert.equal(stopLoss.trigger.positionRatio, 0.25);
  assert.equal(stopLoss.session.position.quantity, 1.5);
  assert.equal(stopLoss.session.risk, null);
});

test("右键价格可创建带仓位比例的限价开仓，下一根到价后成交并完整记录", () => {
  let current = placeTrainingLimitOrder(session({ id: "training-limit-open" }), {
    side: "buy",
    price: 95,
    currentPrice: 100,
    ratio: 0.5,
    time: "2026-07-16T08:01:00.000Z",
  });

  assert.equal(current.limitOrders.length, 1);
  assert.deepEqual(current.limitOrders[0], {
    limitOrderId: "training-limit-open-limit-1",
    side: "buy",
    price: 95,
    ratio: 0.5,
    intent: "open",
    positionSide: "long",
    createdAt: "2026-07-16T08:01:00.000Z",
  });
  assert.equal(current.limitOrderChanges.at(-1).type, "place");

  const result = processTrainingCandle(current, {
    time: 1_700_000_300,
    open: 98,
    high: 101,
    low: 94,
    close: 99,
  }, {
    time: "2026-07-16T08:02:00.000Z",
  });

  assert.equal(result.limitTriggers.length, 1);
  assert.equal(result.limitTriggers[0].limitOrderId, current.limitOrders[0].limitOrderId);
  assert.equal(result.limitTriggers[0].price, 95);
  assert.equal(result.session.limitOrders.length, 0);
  assert.equal(result.session.limitOrderChanges.at(-1).type, "trigger");
  assert.equal(result.session.position.side, "long");
  assert.equal(result.session.actions.at(-1).type, "open");
  assert.equal(result.session.actions.at(-1).capitalRatio, 0.5);
  assert.equal(result.session.actions.at(-1).trigger, "limitOrder");
});

test("反向限价单按设置比例减仓，跳空时使用不差于限价的成交价", () => {
  let current = act(session({ id: "training-limit-reduce" }), {
    type: "open",
    side: "long",
    price: 100,
    quantity: 4,
  });
  current = placeTrainingLimitOrder(current, {
    side: "sell",
    price: 110,
    currentPrice: 100,
    ratio: 0.5,
    time: "2026-07-16T08:02:00.000Z",
  });

  const result = processTrainingCandle(current, {
    time: 1_700_000_300,
    open: 112,
    high: 115,
    low: 108,
    close: 113,
  }, {
    time: "2026-07-16T08:03:00.000Z",
  });

  assert.equal(result.limitTriggers[0].price, 112);
  assert.equal(result.session.actions.at(-1).type, "reduce");
  assert.equal(result.session.actions.at(-1).positionRatio, 0.5);
  assert.equal(result.session.position.quantity, 2);
});

test("限价单可撤销，买卖价格方向无效时拒绝创建", () => {
  const initial = session({ id: "training-limit-cancel" });
  assert.throws(
    () => placeTrainingLimitOrder(initial, {
      side: "buy",
      price: 101,
      currentPrice: 100,
      ratio: 0.5,
      time: "2026-07-16T08:01:00.000Z",
    }),
    /买入限价必须低于当前价格/,
  );
  assert.throws(
    () => placeTrainingLimitOrder(initial, {
      side: "sell",
      price: 99,
      currentPrice: 100,
      ratio: 0.5,
      time: "2026-07-16T08:01:00.000Z",
    }),
    /卖出限价必须高于当前价格/,
  );

  const placed = placeTrainingLimitOrder(initial, {
    side: "buy",
    price: 95,
    currentPrice: 100,
    ratio: 0.25,
    time: "2026-07-16T08:01:00.000Z",
  });
  const cancelled = cancelTrainingLimitOrder(placed, {
    limitOrderId: placed.limitOrders[0].limitOrderId,
    time: "2026-07-16T08:02:00.000Z",
  });
  assert.equal(cancelled.limitOrders.length, 0);
  assert.equal(cancelled.limitOrderChanges.at(-1).type, "cancel");
  assert.throws(
    () => finishTrainingSession(placed, {
      endedAt: "2026-07-16T08:03:00.000Z",
    }),
    /撤销全部限价单/,
  );
});

test("缺少新审计字段的旧训练记录仍可继续交易并正常结束", () => {
  const legacy = act(session({ id: "legacy-training" }), {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
  });
  delete legacy.riskChanges;
  delete legacy.limitOrders;
  delete legacy.limitOrderChanges;
  delete legacy.actions[0].actionId;
  delete legacy.actions[0].recordedAt;
  delete legacy.actions[0].marketLocation;
  delete legacy.actions[0].riskBefore;
  delete legacy.actions[0].riskAfter;

  const closed = applyTrainingAction(legacy, {
    type: "close",
    price: 105,
    time: "2026-07-16T08:02:00.000Z",
  });
  const result = finishTrainingSession(closed, {
    endedAt: "2026-07-16T08:03:00.000Z",
  });

  assert.equal(result.actions.length, 2);
  assert.equal(result.actions[0].recordedAt, result.actions[0].time);
  assert.equal(result.actions[0].marketLocation, undefined);
  assert.deepEqual(result.riskChanges, []);
  assert.deepEqual(result.limitOrders, []);
  assert.deepEqual(result.limitOrderChanges, []);
});

test("同一根 K 线同时触及 TP 与 SL 时保守地先按 SL 全部平仓", () => {
  let current = act(session(), {
    type: "open",
    side: "long",
    price: 100,
    margin: 100,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: 110,
    stopLoss: 90,
    time: "2026-07-16T08:01:30.000Z",
  });

  const result = processTrainingCandle(current, {
    time: 1_700_000_300,
    open: 100,
    high: 115,
    low: 85,
    close: 105,
    volume: 20,
    closeTime: 1_700_000_599_999,
  }, {
    time: "2026-07-16T08:02:00.000Z",
  });

  assert.equal(result.trigger.kind, "stopLoss");
  assert.equal(result.trigger.price, 90);
  assert.equal(result.session.position, null);
  assert.equal(result.session.realizedPnl, -20);
  assert.equal(result.session.actions.at(-1).trigger, "stopLoss");
});

test("空仓下一根 K 线使用相反触发方向，止盈仍按设定价格成交", () => {
  let current = act(session({ id: "training-short-trigger" }), {
    type: "open",
    side: "short",
    price: 100,
    margin: 100,
  });
  current = setTrainingRiskLevels(current, {
    takeProfit: 90,
    stopLoss: 110,
    time: "2026-07-16T08:01:30.000Z",
  });
  const result = processTrainingCandle(current, {
    time: 1_700_000_300,
    open: 100,
    high: 105,
    low: 88,
    close: 95,
    volume: 20,
    closeTime: 1_700_000_599_999,
  }, {
    time: "2026-07-16T08:02:00.000Z",
  });

  assert.equal(result.trigger.kind, "takeProfit");
  assert.equal(result.trigger.price, 90);
  assert.equal(result.session.realizedPnl, 20);
  assert.equal(result.session.actions.at(-1).side, "short");
});

test("平价平仓会清理浮点负零", () => {
  let current = session();
  current = act(current, {
    type: "open",
    side: "short",
    price: 100,
    quantity: 1,
  });
  current = act(current, { type: "close", price: 100 });
  const result = finishTrainingSession(current, {
    endedAt: "2026-07-16T09:00:00.000Z",
  });

  assert.equal(Object.is(current.realizedPnl, -0), false);
  assert.equal(Object.is(result.netPnl, -0), false);
  assert.equal(Object.is(result.returnRate, -0), false);
});

test("多次训练统计总盈亏、胜率、平均盈亏比、累计曲线和 UTC+8 每日汇总", () => {
  function finished({ id, side, exitPrice, endedAt }) {
    let current = session({ id, leverage: 1 });
    current = act(current, {
      type: "open",
      side,
      price: 100,
      margin: 100,
    });
    current = act(current, {
      type: "close",
      price: exitPrice,
      time: endedAt,
    });
    return finishTrainingSession(current, { endedAt });
  }

  const win = finished({
    id: "win",
    side: "long",
    exitPrice: 110,
    endedAt: "2026-07-16T15:00:00.000Z",
  });
  const loss = finished({
    id: "loss",
    side: "short",
    exitPrice: 120,
    endedAt: "2026-07-16T16:00:00.000Z",
  });
  const flat = finished({
    id: "flat",
    side: "long",
    exitPrice: 100,
    endedAt: "2026-07-17T01:00:00.000Z",
  });
  const idle = finishTrainingSession(session({ id: "idle", leverage: 1 }), {
    endedAt: "2026-07-17T02:00:00.000Z",
  });

  assert.deepEqual(calculateTrainingPerformance([idle, flat, loss, win]), {
    totalSessions: 3,
    totalPnl: -10,
    wins: 1,
    losses: 1,
    winRate: 33.333333333333,
    averageWin: 10,
    averageLoss: -20,
    averageProfitLossRatio: 0.5,
    cumulativeCurve: [
      {
        sessionId: "win",
        date: "2026-07-16",
        time: Date.parse("2026-07-16T15:00:00.000Z"),
        pnl: 10,
        cumulativePnl: 10,
      },
      {
        sessionId: "loss",
        date: "2026-07-17",
        time: Date.parse("2026-07-16T16:00:00.000Z"),
        pnl: -20,
        cumulativePnl: -10,
      },
      {
        sessionId: "flat",
        date: "2026-07-17",
        time: Date.parse("2026-07-17T01:00:00.000Z"),
        pnl: 0,
        cumulativePnl: -10,
      },
    ],
    daily: [
      { date: "2026-07-16", pnl: 10, sessions: 1, wins: 1, losses: 0 },
      { date: "2026-07-17", pnl: -20, sessions: 2, wins: 0, losses: 1 },
    ],
  });
});
