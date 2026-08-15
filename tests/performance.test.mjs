import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyPerformanceCalendar,
  calculateTradePerformance,
  filterTradesByCloseDate,
  getTradeCloseDateKey,
  getTradeCloseTime,
  groupTradesByCloseDate,
} from "../lib/performance.mjs";

function closedTrade(overrides = {}) {
  return {
    id: "trade-default",
    symbol: "BTCUSDT",
    side: "long",
    quantity: 1,
    entryPrice: 100,
    fee: 0,
    exits: [
      {
        quantity: 1,
        exitPrice: 110,
        exitTime: "2026-07-16T08:00:00.000Z",
        fee: 0,
      },
    ],
    ...overrides,
  };
}

test("最终平仓时间取 exits 中时间最晚的有效成交，并兼容顶层 exitTime", () => {
  const trade = closedTrade({
    exitTime: "2026-07-20T00:00:00.000Z",
    exits: [
      { quantity: 0.5, exitPrice: 105, exitTime: "无效时间" },
      {
        quantity: 0.5,
        exitPrice: 108,
        exitTime: "2026-07-16T09:00:00.000Z",
      },
      {
        quantity: 0.5,
        exitPrice: 110,
        exitTime: "2026-07-16T08:00:00.000Z",
      },
    ],
  });

  assert.equal(
    getTradeCloseTime(trade),
    Date.parse("2026-07-16T09:00:00.000Z"),
  );
  assert.equal(
    getTradeCloseTime({ exitTime: "2026-07-20T00:00:00.000Z" }),
    Date.parse("2026-07-20T00:00:00.000Z"),
  );
  assert.equal(getTradeCloseTime({ exitTime: "无效时间" }), null);
});

test("归档日期固定使用 UTC+8 并正确跨越零点", () => {
  assert.equal(
    getTradeCloseDateKey(
      closedTrade({
        exits: [
          {
            quantity: 1,
            exitPrice: 110,
            exitTime: "2026-07-16T15:59:59.999Z",
          },
        ],
      }),
    ),
    "2026-07-16",
  );
  assert.equal(
    getTradeCloseDateKey(
      closedTrade({
        exits: [
          {
            quantity: 1,
            exitPrice: 110,
            exitTime: "2026-07-16T16:00:00.000Z",
          },
        ],
      }),
    ),
    "2026-07-17",
  );
  assert.equal(getTradeCloseDateKey({}), null);
});

test("筛选和分组按 id 使用最后一份记录去重，每笔只归入最终平仓日期", () => {
  const trades = [
    closedTrade({
      id: "duplicate",
      exits: [
        {
          quantity: 1,
          exitPrice: 101,
          exitTime: "2026-07-14T02:00:00.000Z",
        },
      ],
    }),
    closedTrade({
      id: "split-exit",
      quantity: 2,
      exits: [
        {
          quantity: 1,
          exitPrice: 105,
          exitTime: "2026-07-15T04:00:00.000Z",
        },
        {
          quantity: 1,
          exitPrice: 110,
          exitTime: "2026-07-16T04:00:00.000Z",
        },
      ],
    }),
    closedTrade({
      id: "duplicate",
      exits: [
        {
          quantity: 1,
          exitPrice: 109,
          exitTime: "2026-07-16T18:00:00.000Z",
        },
      ],
    }),
    closedTrade({
      id: "newest",
      exits: [
        {
          quantity: 1,
          exitPrice: 112,
          exitTime: "2026-07-17T18:00:00.000Z",
        },
      ],
    }),
    closedTrade({ id: "no-close-time", exits: [] }),
  ];

  assert.deepEqual(
    filterTradesByCloseDate(trades, "2026-07-17").map((trade) => trade.id),
    ["duplicate"],
  );
  assert.deepEqual(
    filterTradesByCloseDate(trades, "2026-07-16").map((trade) => trade.id),
    ["split-exit"],
  );
  assert.deepEqual(
    filterTradesByCloseDate(trades, null).map((trade) => trade.id),
    ["no-close-time", "newest", "duplicate", "split-exit"],
  );
  assert.deepEqual(
    groupTradesByCloseDate(trades).map((group) => ({
      date: group.date,
      count: group.count,
      ids: group.trades.map((trade) => trade.id),
    })),
    [
      { date: "2026-07-18", count: 1, ids: ["newest"] },
      { date: "2026-07-17", count: 1, ids: ["duplicate"] },
      { date: "2026-07-16", count: 1, ids: ["split-exit"] },
    ],
  );
});

test("交易表现仅统计完全平仓交易，并按最终平仓时间升序累计", () => {
  const staleDuplicate = closedTrade({
    id: "win",
    entryPrice: 100,
    exits: [
      {
        quantity: 1,
        exitPrice: 999,
        exitTime: "2026-07-10T00:00:00.000Z",
      },
    ],
  });
  const loss = closedTrade({
    id: "loss",
    side: "short",
    entryPrice: 200,
    exits: [
      {
        quantity: 1,
        exitPrice: 220,
        exitTime: "2026-07-16T16:10:00.000Z",
      },
    ],
  });
  const win = closedTrade({
    id: "win",
    quantity: 2,
    entryPrice: 100,
    fee: 2,
    exits: [
      {
        quantity: 1,
        exitPrice: 110,
        exitTime: "2026-07-16T15:00:00.000Z",
        fee: 1,
      },
      {
        quantity: 1,
        exitPrice: 120,
        exitTime: "2026-07-16T16:30:00.000Z",
        fee: 1,
      },
    ],
  });
  const flat = closedTrade({
    id: "flat",
    entryPrice: 80,
    exits: [
      {
        quantity: 1,
        exitPrice: 80,
        exitTime: "2026-07-17T01:00:00.000Z",
      },
    ],
  });
  const nextDayWin = closedTrade({
    id: "next-day-win",
    entryPrice: 50,
    exits: [
      {
        quantity: 1,
        exitPrice: 55,
        exitTime: "2026-07-17T16:00:00.000Z",
      },
    ],
  });
  const partial = closedTrade({
    id: "partial",
    quantity: 2,
    exits: [
      {
        quantity: 1,
        exitPrice: 130,
        exitTime: "2026-07-18T00:00:00.000Z",
      },
    ],
  });
  const closedWithoutTime = closedTrade({
    id: "closed-without-time",
    exits: [{ quantity: 1, exitPrice: 120, exitTime: null }],
  });

  assert.deepEqual(
    calculateTradePerformance([
      staleDuplicate,
      loss,
      win,
      flat,
      nextDayWin,
      partial,
      closedWithoutTime,
    ]),
    {
      points: [
        {
          tradeId: "loss",
          date: "2026-07-17",
          time: Date.parse("2026-07-16T16:10:00.000Z"),
          pnl: -20,
          cumulativePnl: -20,
        },
        {
          tradeId: "win",
          date: "2026-07-17",
          time: Date.parse("2026-07-16T16:30:00.000Z"),
          pnl: 26,
          cumulativePnl: 6,
        },
        {
          tradeId: "flat",
          date: "2026-07-17",
          time: Date.parse("2026-07-17T01:00:00.000Z"),
          pnl: 0,
          cumulativePnl: 6,
        },
        {
          tradeId: "next-day-win",
          date: "2026-07-18",
          time: Date.parse("2026-07-17T16:00:00.000Z"),
          pnl: 5,
          cumulativePnl: 11,
        },
      ],
      daily: [
        { date: "2026-07-17", pnl: 6, trades: 3, wins: 1, losses: 1 },
        { date: "2026-07-18", pnl: 5, trades: 1, wins: 1, losses: 0 },
      ],
      totalPnl: 11,
      totalFees: 4,
      knownFeeTrades: 4,
      unknownFeeTrades: 0,
      closedTrades: 4,
      wins: 2,
      losses: 1,
      winRate: 50,
      averageWin: 15.5,
      averageLoss: -20,
      profitLossRatio: 0.775,
    },
  );
});

test("手续费统计只汇总已平仓交易，未平仓不会触发手续费缺失", () => {
  const known = closedTrade({
    id: "known-fee",
    fee: 2,
    exits: [{
      quantity: 1,
      exitPrice: 110,
      exitTime: "2026-07-16T08:00:00.000Z",
      fee: 1,
    }],
  });
  const unknown = closedTrade({
    id: "unknown-fee",
    feesKnown: false,
    exits: [{
      quantity: 1,
      exitPrice: 105,
      exitTime: "2026-07-17T08:00:00.000Z",
      fee: 0,
    }],
  });
  const open = closedTrade({
    id: "open-unknown-fee",
    quantity: 2,
    feesKnown: false,
    exits: [{
      quantity: 1,
      exitPrice: 105,
      exitTime: "2026-07-18T08:00:00.000Z",
      fee: 0,
    }],
    exitPrice: null,
    exitTime: null,
    openPosition: { markPrice: 106 },
  });

  const performance = calculateTradePerformance([known, unknown, open]);

  assert.equal(getTradeCloseTime(open), null);
  assert.equal(getTradeCloseDateKey(open), null);
  assert.equal(performance.closedTrades, 2);
  assert.equal(performance.totalFees, 3);
  assert.equal(performance.knownFeeTrades, 1);
  assert.equal(performance.unknownFeeTrades, 1);
});

test("没有盈利或没有亏损时盈亏比为 null", () => {
  const onlyWin = calculateTradePerformance([
    closedTrade({ id: "only-win" }),
  ]);
  assert.equal(onlyWin.averageWin, 10);
  assert.equal(onlyWin.averageLoss, 0);
  assert.equal(onlyWin.profitLossRatio, null);

  const onlyLoss = calculateTradePerformance([
    closedTrade({
      id: "only-loss",
      side: "short",
      exits: [
        {
          quantity: 1,
          exitPrice: 110,
          exitTime: "2026-07-16T08:00:00.000Z",
        },
      ],
    }),
  ]);
  assert.equal(onlyLoss.averageWin, 0);
  assert.equal(onlyLoss.averageLoss, -10);
  assert.equal(onlyLoss.profitLossRatio, null);
});

test("每日盈利日历按周一开头生成月份，并区分零盈利日与范围外日期", () => {
  const months = buildDailyPerformanceCalendar([
    { date: "2026-07-15", pnl: 12.5, trades: 2, wins: 2, losses: 0 },
    { date: "2026-07-17", pnl: -4, trades: 1, wins: 0, losses: 1 },
    { date: "2026-08-03", pnl: 0, trades: 1, wins: 0, losses: 0 },
  ]);

  assert.deepEqual(months.map(({ key, label }) => ({ key, label })), [
    { key: "2026-07", label: "2026年7月" },
    { key: "2026-08", label: "2026年8月" },
  ]);
  assert.equal(months[0].weeks.every((week) => week.length === 7), true);
  assert.equal(months[0].weeks[0][0], null);
  assert.equal(months[0].weeks[0][1], null);

  const julyDays = months[0].weeks.flat().filter(Boolean);
  const beforeRange = julyDays.find((day) => day.date === "2026-07-14");
  const zeroDay = julyDays.find((day) => day.date === "2026-07-16");
  const lossDay = julyDays.find((day) => day.date === "2026-07-17");
  assert.equal(beforeRange.inRange, false);
  assert.equal(lossDay.day, 17);
  assert.deepEqual(
    { inRange: zeroDay.inRange, hasTrades: zeroDay.hasTrades, pnl: zeroDay.pnl },
    { inRange: true, hasTrades: false, pnl: 0 },
  );
  assert.deepEqual(
    { hasTrades: lossDay.hasTrades, pnl: lossDay.pnl, losses: lossDay.losses },
    { hasTrades: true, pnl: -4, losses: 1 },
  );
});
