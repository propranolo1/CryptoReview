import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceReplayFrame,
  buildPartialCandle,
  buildReplayPositionState,
  buildReplayProgressNodes,
  buildReplayMarketDataKey,
  buildReplayTradeSnapshot,
  formatPositionRatioLabel,
  getCandlePhaseAtTime,
  getReplayOpenInterestPoints,
  getReplayTimeMs,
  getReplayVolume,
  locateReplayCandleAtTime,
  locateReplayFrameAtTime,
} from "../lib/replay.mjs";

test("公开带单轮询只替换数组引用时不应触发行情重载", () => {
  const baseTrade = {
    id: "smart-money-skhynix",
    symbol: "SKHYNIXUSDT",
    side: "long",
    entryPrice: 1_170.83,
    entryTime: "2026-07-17T13:03:00+08:00",
    marketDataSource: "binance-futures",
    exits: [
      {
        exitTime: "2026-07-17T18:16:00+08:00",
        exitPrice: 1_190.28647,
        quantity: 2.92,
      },
    ],
  };

  const beforePolling = buildReplayMarketDataKey(baseTrade, "5m");
  const afterPolling = buildReplayMarketDataKey(
    {
      ...baseTrade,
      exits: baseTrade.exits.map((exit) => ({ ...exit })),
    },
    "5m",
  );

  assert.equal(afterPolling, beforePolling);
  assert.notEqual(
    buildReplayMarketDataKey(
      {
        ...baseTrade,
        exits: [
          ...baseTrade.exits,
          {
            exitTime: "2026-07-17T18:39:00+08:00",
            exitPrice: 1_191.5,
            quantity: 5.44,
          },
        ],
      },
      "5m",
    ),
    beforePolling,
  );
});

test("切换时间周期后按同一回放时间定位游标和单根 K 线进度", () => {
  const candles = [
    { time: 1_800_000_000, closeTime: 1_800_003_599_999 },
    { time: 1_800_003_600, closeTime: 1_800_007_199_999 },
    { time: 1_800_007_200, closeTime: 1_800_010_799_999 },
  ];

  const middle = locateReplayFrameAtTime(candles, 1_800_005_400_000);
  assert.equal(middle.cursor, 1);
  assert.ok(Math.abs(middle.phase - 0.5) < 0.000001);
  assert.deepEqual(
    locateReplayFrameAtTime(candles, 1_799_999_000_000, 1),
    { cursor: 1, phase: 0 },
  );
});

test("双击回放图表按目标时间定位到对应 K 线完成状态", () => {
  const candles = [
    { time: 1_800_000_000, closeTime: 1_800_003_599_999 },
    { time: 1_800_003_600, closeTime: 1_800_007_199_999 },
    { time: 1_800_007_200, closeTime: 1_800_010_799_999 },
  ];

  assert.deepEqual(
    locateReplayCandleAtTime(candles, 1_800_007_200_000, 1, 0.35),
    { cursor: 2, phase: 1 },
  );
  assert.deepEqual(
    locateReplayCandleAtTime(candles, 1_799_999_000_000, 1, 0.35),
    { cursor: 1, phase: 0.35 },
  );
});

const risingCandle = {
  time: 1_700_000_000,
  open: 100,
  high: 120,
  low: 90,
  close: 115,
  volume: 42,
};

const fallingCandle = {
  time: 1_700_003_600,
  open: 100,
  high: 115,
  low: 80,
  close: 85,
  volume: 24,
};

test("上涨 K 线按开盘、最低、最高、收盘的顺序演进", () => {
  assert.deepEqual(buildPartialCandle(risingCandle, 0), {
    ...risingCandle,
    high: 100,
    low: 100,
    close: 100,
  });

  // 第一阶段只向最低价运行，尚未发生的最高价不能提前出现。
  assert.deepEqual(buildPartialCandle(risingCandle, 1 / 6), {
    ...risingCandle,
    high: 100,
    low: 95,
    close: 95,
  });
  assert.deepEqual(buildPartialCandle(risingCandle, 1 / 3), {
    ...risingCandle,
    high: 100,
    low: 90,
    close: 90,
  });

  // 第二阶段由最低价运行至最高价，只显示当前已经触达的区间。
  assert.deepEqual(buildPartialCandle(risingCandle, 1 / 2), {
    ...risingCandle,
    high: 105,
    low: 90,
    close: 105,
  });
  assert.deepEqual(buildPartialCandle(risingCandle, 2 / 3), {
    ...risingCandle,
    high: 120,
    low: 90,
    close: 120,
  });

  // 最后一阶段从最高价回落至真实收盘价。
  assert.deepEqual(buildPartialCandle(risingCandle, 5 / 6), {
    ...risingCandle,
    high: 120,
    low: 90,
    close: 117.5,
  });
  assert.deepEqual(buildPartialCandle(risingCandle, 1), risingCandle);
});

test("下跌 K 线按开盘、最高、最低、收盘的顺序演进", () => {
  // 第一阶段只向最高价运行，尚未发生的最低价不能提前出现。
  assert.deepEqual(buildPartialCandle(fallingCandle, 1 / 6), {
    ...fallingCandle,
    high: 107.5,
    low: 100,
    close: 107.5,
  });
  assert.deepEqual(buildPartialCandle(fallingCandle, 1 / 3), {
    ...fallingCandle,
    high: 115,
    low: 100,
    close: 115,
  });

  // 第二阶段由最高价运行至最低价，最低价随运行过程逐步出现。
  assert.deepEqual(buildPartialCandle(fallingCandle, 1 / 2), {
    ...fallingCandle,
    high: 115,
    low: 97.5,
    close: 97.5,
  });
  assert.deepEqual(buildPartialCandle(fallingCandle, 2 / 3), {
    ...fallingCandle,
    high: 115,
    low: 80,
    close: 80,
  });

  // 最后一阶段从最低价反弹至真实收盘价。
  assert.deepEqual(buildPartialCandle(fallingCandle, 5 / 6), {
    ...fallingCandle,
    high: 115,
    low: 80,
    close: 82.5,
  });
  assert.deepEqual(buildPartialCandle(fallingCandle, 1), fallingCandle);
});

test("K 线内部进度会被限制在 0 到 1", () => {
  assert.deepEqual(buildPartialCandle(risingCandle, -3), {
    ...risingCandle,
    high: risingCandle.open,
    low: risingCandle.open,
    close: risingCandle.open,
  });
  assert.deepEqual(buildPartialCandle(risingCandle, 7), risingCandle);
});

test("K 线内部进度会映射为当前回放时间，供成交事件按时出现", () => {
  const candle = { ...risingCandle, time: 1_000, closeTime: 1_059_999 };
  assert.equal(getReplayTimeMs(candle, 0), 1_000_000);
  assert.equal(getReplayTimeMs(candle, 0.5), 1_030_000);
  assert.equal(getReplayTimeMs(candle, 1), 1_059_999);

  const candleWithoutCloseTime = { ...risingCandle, time: 1_000 };
  assert.equal(
    getReplayTimeMs(candleWithoutCloseTime, 1, { time: 1_060 }),
    1_059_999,
  );
});

test("从入场时间开始回放时会定位到入场所在的 K 线内部进度", () => {
  const candle = { ...risingCandle, time: 1_000, closeTime: 1_059_999 };
  assert.equal(getCandlePhaseAtTime(candle, 999_000), 0);
  assert.ok(Math.abs(getCandlePhaseAtTime(candle, 1_030_000) - 0.5) < 0.0001);
  assert.equal(getCandlePhaseAtTime(candle, 1_070_000), 1);
});

test("回放帧先完成当前 K 线，下一帧才进入新 K 线", () => {
  assert.deepEqual(
    advanceReplayFrame({ cursor: 2, phase: 0.4 }, 5, 0.25),
    { cursor: 2, phase: 0.65, finished: false },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 2, phase: 0.9 }, 5, 0.25),
    { cursor: 2, phase: 1, finished: false },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 2, phase: 1 }, 5, 0.25),
    { cursor: 3, phase: 0, finished: false },
  );
});

test("固定十二个内部阶段后完整显示当前 K 线，下一帧才换根", () => {
  let state = { cursor: 0, phase: 0 };
  for (let index = 0; index < 12; index += 1) {
    state = advanceReplayFrame(state, 3, 1 / 12);
  }
  assert.deepEqual(state, { cursor: 0, phase: 1, finished: false });
  assert.deepEqual(
    advanceReplayFrame(state, 3, 1 / 12),
    { cursor: 1, phase: 0, finished: false },
  );
});

test("单根数据会完整渲染后停在完成状态", () => {
  assert.deepEqual(
    advanceReplayFrame({ cursor: 0, phase: 0 }, 1, 0.6),
    { cursor: 0, phase: 0.6, finished: false },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 0, phase: 0.6 }, 1, 0.6),
    { cursor: 0, phase: 1, finished: true },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 0, phase: 1 }, 1, 0.6),
    { cursor: 0, phase: 1, finished: true },
  );
});

test("回放状态和步长会被限制，末尾不会越过最后一根 K 线", () => {
  assert.deepEqual(
    advanceReplayFrame({ cursor: -8, phase: -2 }, 3, -1),
    { cursor: 0, phase: 0, finished: false },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 99, phase: 0.8 }, 3, 9),
    { cursor: 2, phase: 1, finished: true },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 2, phase: 1 }, 3, 0.2),
    { cursor: 2, phase: 1, finished: true },
  );
  assert.deepEqual(
    advanceReplayFrame({ cursor: 4, phase: 0.5 }, 0, 0.2),
    { cursor: 0, phase: 0, finished: true },
  );
});

test("当前 K 线成交量随回放进度逐步形成", () => {
  assert.equal(getReplayVolume(42, 0), 0);
  assert.equal(getReplayVolume(42, 0.5), 21);
  assert.equal(getReplayVolume(42, 1), 42);
  assert.equal(getReplayVolume(42, -2), 0);
  assert.equal(getReplayVolume(42, 3), 42);
});

test("OI 只显示到当前回放时刻，回退会重新隐藏未来数据", () => {
  const points = [
    { time: 1_000, openInterest: 10, openInterestValue: 100 },
    { time: 1_300, openInterest: 11, openInterestValue: 110 },
    { time: 1_600, openInterest: 12, openInterestValue: 120 },
  ];

  assert.deepEqual(getReplayOpenInterestPoints(points, 1_450_000), points.slice(0, 2));
  assert.deepEqual(getReplayOpenInterestPoints(points, 1_050_000), points.slice(0, 1));
  assert.deepEqual(getReplayOpenInterestPoints(points, 999_000), []);
});

test("历史交易只有总入场数量时，也能按分批平仓显示剩余仓位比例", () => {
  const trade = {
    quantity: 10,
    entryPrice: 100,
    entryTime: "2026-07-20T10:00:00.000Z",
    exits: [
      {
        quantity: 5,
        exitPrice: 105,
        exitTime: "2026-07-20T11:00:00.000Z",
        fee: 0,
      },
      {
        quantity: 5,
        exitPrice: 110,
        exitTime: "2026-07-20T12:00:00.000Z",
        fee: 0,
      },
    ],
  };

  assert.deepEqual(
    buildReplayPositionState(trade, Date.parse("2026-07-20T09:59:59.999Z")),
    {
      hasEntered: false,
      isClosed: false,
      currentQuantity: 0,
      peakQuantity: 0,
      ratio: 0,
      label: "0",
      segments: [],
    },
  );

  const entered = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T10:30:00.000Z"),
  );
  assert.equal(entered.currentQuantity, 10);
  assert.equal(entered.peakQuantity, 10);
  assert.equal(entered.ratio, 1);
  assert.equal(entered.label, "1");
  assert.equal(entered.segments.length, 1);
  assert.equal(entered.segments[0].remainingQuantity, 10);
  assert.equal(entered.segments[0].isAddition, false);

  const half = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T11:30:00.000Z"),
  );
  assert.equal(half.currentQuantity, 5);
  assert.equal(half.peakQuantity, 10);
  assert.equal(half.ratio, 0.5);
  assert.equal(half.label, "1/2");
  assert.equal(half.segments[0].remainingQuantity, 5);

  const closed = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T12:30:00.000Z"),
  );
  assert.equal(closed.currentQuantity, 0);
  assert.equal(closed.peakQuantity, 10);
  assert.equal(closed.ratio, 0);
  assert.equal(closed.label, "0");
  assert.equal(closed.isClosed, true);
  assert.deepEqual(closed.segments, []);
});

test("回放仓位状态保留每次加仓来源，平仓按比例缩减各颜色段", () => {
  const trade = {
    quantity: 7,
    entryPrice: 101,
    entryTime: "2026-07-20T10:00:00.000Z",
    entries: [
      {
        id: "fill-base",
        sourceOrderId: "order-base",
        quantity: 4,
        entryPrice: 100,
        entryTime: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "fill-add-a",
        sourceOrderId: "order-add-a",
        quantity: 2,
        entryPrice: 102,
        entryTime: "2026-07-20T10:30:00.000Z",
      },
      {
        id: "fill-add-b",
        sourceOrderId: "order-add-b",
        quantity: 1,
        entryPrice: 103,
        entryTime: "2026-07-20T11:30:00.000Z",
      },
    ],
    exits: [{
      quantity: 3,
      exitPrice: 104,
      exitTime: "2026-07-20T11:00:00.000Z",
      fee: 0,
    }],
  };

  const beforeFutureAdds = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T10:15:00.000Z"),
  );
  assert.equal(beforeFutureAdds.currentQuantity, 4);
  assert.equal(beforeFutureAdds.peakQuantity, 4);
  assert.equal(beforeFutureAdds.ratio, 1);
  assert.deepEqual(
    beforeFutureAdds.segments.map((segment) => segment.sourceOrderId),
    ["order-base"],
  );

  const afterFirstAdd = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T10:45:00.000Z"),
  );
  assert.equal(afterFirstAdd.currentQuantity, 6);
  assert.equal(afterFirstAdd.peakQuantity, 6);
  assert.equal(afterFirstAdd.ratio, 1);
  assert.deepEqual(
    afterFirstAdd.segments.map((segment) => ({
      sourceOrderId: segment.sourceOrderId,
      remainingQuantity: segment.remainingQuantity,
      ratio: segment.ratio,
      colorIndex: segment.colorIndex,
      isAddition: segment.isAddition,
    })),
    [
      {
        sourceOrderId: "order-base",
        remainingQuantity: 4,
        ratio: 2 / 3,
        colorIndex: 0,
        isAddition: false,
      },
      {
        sourceOrderId: "order-add-a",
        remainingQuantity: 2,
        ratio: 1 / 3,
        colorIndex: 1,
        isAddition: true,
      },
    ],
  );

  const afterHalfClose = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T11:15:00.000Z"),
  );
  assert.equal(afterHalfClose.currentQuantity, 3);
  assert.equal(afterHalfClose.peakQuantity, 6);
  assert.equal(afterHalfClose.ratio, 0.5);
  assert.equal(afterHalfClose.label, "1/2");
  assert.deepEqual(
    afterHalfClose.segments.map((segment) => segment.remainingQuantity),
    [2, 1],
  );

  const afterSecondAdd = buildReplayPositionState(
    trade,
    Date.parse("2026-07-20T11:45:00.000Z"),
  );
  assert.equal(afterSecondAdd.currentQuantity, 4);
  assert.equal(afterSecondAdd.peakQuantity, 6);
  assert.ok(Math.abs(afterSecondAdd.ratio - 2 / 3) < 1e-10);
  assert.equal(afterSecondAdd.label, "2/3");
  assert.deepEqual(
    afterSecondAdd.segments.map((segment) => ({
      remainingQuantity: segment.remainingQuantity,
      colorIndex: segment.colorIndex,
    })),
    [
      { remainingQuantity: 2, colorIndex: 0 },
      { remainingQuantity: 1, colorIndex: 1 },
      { remainingQuantity: 1, colorIndex: 2 },
    ],
  );
});

test("同一开仓订单的多笔成交共用颜色，非简单比例显示百分比", () => {
  const state = buildReplayPositionState({
    quantity: 3,
    entryPrice: 100,
    entryTime: "2026-07-20T10:00:00.000Z",
    entries: [
      {
        id: "fill-1",
        sourceOrderId: "order-1",
        quantity: 1,
        entryPrice: 100,
        entryTime: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "fill-2",
        sourceOrderId: "order-1",
        quantity: 2,
        entryPrice: 101,
        entryTime: "2026-07-20T10:00:01.000Z",
      },
    ],
    exits: [{
      quantity: 0.51,
      exitPrice: 102,
      exitTime: "2026-07-20T10:30:00.000Z",
      fee: 0,
    }],
  }, Date.parse("2026-07-20T11:00:00.000Z"));

  assert.deepEqual(state.segments.map((segment) => segment.colorIndex), [0, 0]);
  assert.equal(state.label, "83%");
  assert.equal(formatPositionRatioLabel(1), "1");
  assert.equal(formatPositionRatioLabel(0.25), "1/4");
  assert.equal(formatPositionRatioLabel(0.3333333333333333), "1/3");
  assert.equal(formatPositionRatioLabel(0.8304195804), "83%");
});

const scaledEntryTrade = {
  side: "long",
  quantity: 5,
  entryPrice: 106,
  entryTime: "2026-07-21T10:00:00.000Z",
  fee: 0.53,
  entries: [
    {
      id: "entry-base",
      sourceOrderId: "order-base",
      quantity: 2,
      entryPrice: 100,
      entryTime: "2026-07-21T10:00:00.000Z",
      fee: 0.2,
    },
    {
      id: "entry-add",
      sourceOrderId: "order-add",
      quantity: 2,
      entryPrice: 120,
      entryTime: "2026-07-21T11:00:00.000Z",
      fee: 0.24,
    },
    {
      id: "entry-future",
      sourceOrderId: "order-future",
      quantity: 1,
      entryPrice: 90,
      entryTime: "2026-07-21T13:00:00.000Z",
      fee: 0.09,
    },
  ],
  exits: [
    {
      quantity: 1,
      exitPrice: 110,
      exitTime: "2026-07-21T10:30:00.000Z",
      fee: 0.11,
    },
    {
      quantity: 1.5,
      exitPrice: 130,
      exitTime: "2026-07-21T12:00:00.000Z",
      fee: 0.195,
    },
  ],
};

test("分批开仓快照不会提前使用未来加仓均价和手续费", () => {
  const beforeAddition = buildReplayTradeSnapshot(
    scaledEntryTrade,
    Date.parse("2026-07-21T10:15:00.000Z"),
    105,
  );

  assert.equal(beforeAddition.averageEntryPrice, 100);
  assert.equal(beforeAddition.currentQuantity, 2);
  assert.equal(beforeAddition.peakQuantity, 2);
  assert.equal(beforeAddition.accruedFees, 0.2);
  assert.deepEqual(beforeAddition.visibleEntries.map((entry) => entry.id), ["entry-base"]);
  assert.deepEqual(beforeAddition.visibleExits, []);
  assert.deepEqual(beforeAddition.pnl, {
    entryNotional: 200,
    exitedQuantity: 0,
    remainingQuantity: 2,
    realizedPnl: 0,
    unrealizedPnl: 9.8,
    totalPnl: 9.8,
    returnRate: 0.049,
    returnRatePercent: 4.9,
    entryFees: 0.2,
    exitFees: 0,
    totalFees: 0.2,
  });

  const afterFirstExit = buildReplayTradeSnapshot(
    scaledEntryTrade,
    Date.parse("2026-07-21T10:45:00.000Z"),
    115,
  );
  assert.equal(afterFirstExit.averageEntryPrice, 100);
  assert.equal(afterFirstExit.currentQuantity, 1);
  assert.equal(afterFirstExit.pnl.realizedPnl, 9.79);
  assert.equal(afterFirstExit.pnl.unrealizedPnl, 14.9);
  assert.equal(afterFirstExit.pnl.totalPnl, 24.69);
  assert.equal(afterFirstExit.accruedFees, 0.31);
});

test("资金费只在真实发生时间后进入回放当前仓位盈亏", () => {
  const trade = {
    side: "long",
    quantity: 2,
    entryPrice: 100,
    entryTime: "2026-07-21T10:00:00.000Z",
    fee: 0.2,
    fundingFees: [{
      transactionId: "funding-1",
      amount: -0.75,
      asset: "USDT",
      time: "2026-07-21T10:20:00.000Z",
    }],
  };
  const beforeFunding = buildReplayTradeSnapshot(
    trade,
    Date.parse("2026-07-21T10:15:00.000Z"),
    105,
  );
  const afterFunding = buildReplayTradeSnapshot(
    trade,
    Date.parse("2026-07-21T10:25:00.000Z"),
    105,
  );

  assert.equal(beforeFunding.accruedFundingFee, 0);
  assert.equal(beforeFunding.pnl.totalPnl, 9.8);
  assert.equal(afterFunding.accruedFundingFee, -0.75);
  assert.equal(afterFunding.pnl.fundingFee, -0.75);
  assert.equal(afterFunding.pnl.realizedPnl, -0.75);
  assert.equal(afterFunding.pnl.totalPnl, 9.05);
});

test("加仓后只按已发生 entries 更新成本，早先平仓盈亏不会被新均价回写", () => {
  const afterAddition = buildReplayTradeSnapshot(
    scaledEntryTrade,
    Date.parse("2026-07-21T11:30:00.000Z"),
    125,
  );

  assert.ok(Math.abs(afterAddition.averageEntryPrice - 340 / 3) < 1e-10);
  assert.equal(afterAddition.currentQuantity, 3);
  assert.equal(afterAddition.peakQuantity, 3);
  assert.equal(afterAddition.accruedFees, 0.55);
  assert.equal(afterAddition.pnl.entryNotional, 440);
  assert.equal(afterAddition.pnl.realizedPnl, 9.79);
  assert.equal(afterAddition.pnl.unrealizedPnl, 34.66);
  assert.equal(afterAddition.pnl.totalPnl, 44.45);
  assert.deepEqual(
    afterAddition.visibleEntries.map((entry) => entry.id),
    ["entry-base", "entry-add"],
  );

  const afterSecondExit = buildReplayTradeSnapshot(
    scaledEntryTrade,
    Date.parse("2026-07-21T12:30:00.000Z"),
    125,
  );
  assert.ok(Math.abs(afterSecondExit.averageEntryPrice - 340 / 3) < 1e-10);
  assert.equal(afterSecondExit.currentQuantity, 1.5);
  assert.equal(afterSecondExit.pnl.realizedPnl, 34.425);
  assert.equal(afterSecondExit.pnl.unrealizedPnl, 17.33);
  assert.equal(afterSecondExit.pnl.totalPnl, 51.755);
  assert.equal(afterSecondExit.accruedFees, 0.745);
});

test("每笔开仓和平仓都会生成按真实时间排序的 BUY/SELL 事件", () => {
  const snapshot = buildReplayTradeSnapshot(
    scaledEntryTrade,
    Date.parse("2026-07-21T12:30:00.000Z"),
    125,
  );

  assert.deepEqual(
    snapshot.events.map((event) => ({
      type: event.type,
      side: event.side,
      price: event.price,
      quantity: event.quantity,
      isAddition: event.isAddition,
    })),
    [
      { type: "entry", side: "buy", price: 100, quantity: 2, isAddition: false },
      { type: "exit", side: "sell", price: 110, quantity: 1, isAddition: false },
      { type: "entry", side: "buy", price: 120, quantity: 2, isAddition: true },
      { type: "exit", side: "sell", price: 130, quantity: 1.5, isAddition: false },
    ],
  );
  assert.ok(snapshot.events.every((event) => Number.isFinite(event.timeMs)));
});

test("空仓方向、完全平仓后成本保留及旧版无 entries 记录仍兼容", () => {
  const legacyShort = {
    side: "short",
    quantity: 2,
    entryPrice: 100,
    entryTime: "2026-07-21T10:00:00.000Z",
    fee: 0.2,
    exits: [{
      quantity: 2,
      exitPrice: 90,
      exitTime: "2026-07-21T11:00:00.000Z",
      fee: 0.18,
    }],
  };

  const beforeExit = buildReplayTradeSnapshot(
    legacyShort,
    Date.parse("2026-07-21T10:30:00.000Z"),
    95,
  );
  assert.equal(beforeExit.averageEntryPrice, 100);
  assert.equal(beforeExit.visibleEntries.length, 1);
  assert.equal(beforeExit.visibleEntries[0].id, "legacy-entry");
  assert.equal(beforeExit.pnl.unrealizedPnl, 9.8);

  const closed = buildReplayTradeSnapshot(
    legacyShort,
    Date.parse("2026-07-21T11:30:00.000Z"),
  );
  assert.equal(closed.isClosed, true);
  assert.equal(closed.averageEntryPrice, 100);
  assert.equal(closed.currentQuantity, 0);
  assert.equal(closed.pnl.realizedPnl, 19.62);
  assert.equal(closed.pnl.unrealizedPnl, 0);
  assert.deepEqual(closed.events.map((event) => event.side), ["sell", "buy"]);
});

const progressCandles = [
  { time: 1_000, closeTime: 1_059_999 },
  { time: 1_060, closeTime: 1_119_999 },
  { time: 1_120, closeTime: 1_179_999 },
];

function progressIso(timeMs) {
  return new Date(timeMs).toISOString();
}

test("操作节点会精确定位到 K 线内部进度", () => {
  const nodes = buildReplayProgressNodes({
    quantity: 1,
    exits: [],
    riskLevels: [{
      id: "sl-created",
      kind: "stopLoss",
      price: 95,
      executionType: "market",
      startTime: progressIso(1_030_000),
      endTime: null,
    }],
  }, progressCandles, 0);

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].cursor, 0);
  assert.ok(Math.abs(nodes[0].phase - 0.5) < 0.0001);
  assert.ok(Math.abs(nodes[0].positionPercent - (nodes[0].phase / 3 * 100)) < 0.0001);
  assert.deepEqual(nodes[0].actions.map((action) => action.type), ["risk-created"]);
});

test("五秒内同类撤旧建新会合并为改单，不再重复显示撤单节点", () => {
  const nodes = buildReplayProgressNodes({
    quantity: 1,
    exits: [],
    riskLevels: [
      {
        id: "sl-old",
        kind: "stopLoss",
        price: 95,
        executionType: "market",
        startTime: progressIso(1_010_000),
        endTime: progressIso(1_080_000),
        endState: "cancelled",
      },
      {
        id: "sl-new",
        kind: "stopLoss",
        price: 97,
        executionType: "market",
        startTime: progressIso(1_080_200),
        endTime: progressIso(1_150_000),
        endState: "cancelled",
      },
    ],
  }, progressCandles, 0);

  const actions = nodes.flatMap((node) => node.actions);
  assert.equal(actions.filter((action) => action.type === "risk-modified").length, 1);
  assert.equal(actions.filter((action) => action.type === "risk-cancelled").length, 1);
  assert.deepEqual(
    actions.find((action) => action.type === "risk-modified"),
    {
      type: "risk-modified",
      riskKind: "stopLoss",
      executionType: "market",
      previousPrice: 95,
      price: 97,
      inferred: false,
    },
  );
});

test("条件单触发与一秒内的全部平仓合并为同一个彩色节点", () => {
  const nodes = buildReplayProgressNodes({
    quantity: 2,
    exits: [{
      quantity: 2,
      exitPrice: 94.8,
      exitTime: progressIso(1_120_089),
      fee: 0,
    }],
    riskLevels: [{
      id: "sl-filled",
      kind: "stopLoss",
      price: 95,
      executionType: "market",
      startTime: progressIso(1_020_000),
      endTime: progressIso(1_120_000),
      endState: "filled",
    }],
  }, progressCandles, 0);

  const combined = nodes.find((node) =>
    node.actions.some((action) => action.type === "risk-filled") &&
    node.actions.some((action) => action.type === "full-close"),
  );
  assert.ok(combined);
  assert.equal(combined.tone, "stopLoss");
});

test("分批离场依次标记部分平仓和全部平仓，并忽略回放区间外事件", () => {
  const nodes = buildReplayProgressNodes({
    quantity: 3,
    exits: [
      { quantity: 1, exitPrice: 101, exitTime: progressIso(1_070_000), fee: 0 },
      { quantity: 2, exitPrice: 103, exitTime: progressIso(1_160_000), fee: 0 },
      { quantity: 1, exitPrice: 104, exitTime: progressIso(1_300_000), fee: 0 },
    ],
    riskLevels: [],
  }, progressCandles, 0);

  assert.deepEqual(
    nodes.flatMap((node) => node.actions).map((action) => action.type),
    ["partial-close", "full-close"],
  );
  assert.ok(nodes[0].positionPercent < nodes[1].positionPercent);
});
