import assert from "node:assert/strict";
import test from "node:test";

import {
  createSettlementTrade,
  mergeDefaultAndImportedTrades,
} from "../lib/simulation.mjs";
import { calculateTradePnl } from "../lib/trade.mjs";
import { createHypeScreenshotTrade } from "../lib/records.mjs";

const firstBtcCandle = {
  time: 1_784_044_800,
  open: 64_744,
  high: 64_896.86,
  low: 64_606,
  close: 64_730,
  closeTime: 1_784_048_399_999,
};

const lastBtcCandle = {
  time: 1_784_127_600,
  open: 65_399.8,
  high: 65_600,
  low: 65_261.71,
  close: 65_427.61,
  closeTime: 1_784_131_199_999,
};

test("模拟交割严格使用昨日首根开盘价和末根收盘价", () => {
  const trade = createSettlementTrade({
    symbol: "BTCUSDT",
    side: "long",
    quantity: 0.2,
    candles: [lastBtcCandle, firstBtcCandle],
    stopLoss: 64_000,
    takeProfit: 66_000,
    entryFee: 6.5,
    exitFee: 6.6,
  });

  assert.equal(trade.entryPrice, 64_744);
  assert.equal(trade.entryTime, "2026-07-14T16:00:00.000Z");
  assert.equal(trade.exitPrice, 65_427.61);
  assert.equal(trade.exitTime, "2026-07-15T15:59:59.999Z");
  assert.deepEqual(trade.exits, [
    {
      quantity: 0.2,
      exitPrice: 65_427.61,
      exitTime: "2026-07-15T15:59:59.999Z",
      fee: 6.6,
    },
  ]);
  assert.equal(calculateTradePnl(trade).totalPnl, 123.622);
});

test("SOL 空仓交割按方向计算昨日实际收盘亏损", () => {
  const trade = createSettlementTrade({
    symbol: "SOLUSDT",
    side: "short",
    quantity: 50,
    candles: [
      { time: 1_784_044_800, open: 77.39, close: 77.28 },
      {
        time: 1_784_127_600,
        open: 78.22,
        close: 78.07,
        closeTime: 1_784_131_199_999,
      },
    ],
    stopLoss: 79.2,
    takeProfit: 75,
    entryFee: 3.9,
    exitFee: 4,
  });

  assert.equal(calculateTradePnl(trade).totalPnl, -41.9);
});

test("模拟交割拒绝不足两根或价格无效的行情", () => {
  assert.throws(
    () => createSettlementTrade({
      symbol: "BTCUSDT",
      side: "long",
      quantity: 1,
      candles: [firstBtcCandle],
    }),
    /至少需要两根/,
  );
  assert.throws(
    () => createSettlementTrade({
      symbol: "BTCUSDT",
      side: "long",
      quantity: 1,
      candles: [firstBtcCandle, { ...lastBtcCandle, close: Number.NaN }],
    }),
    /价格无效/,
  );
});

test("刷新内置交割时只保留用户导入交易，不让旧示例覆盖新价格", () => {
  const hype = createHypeScreenshotTrade();
  const defaults = [hype, { id: "btc-breakout" }, { id: "sol-reversal" }];
  const saved = [
    { id: "hype-screenshot-review", entryPrice: 99 },
    { id: "btc-breakout", entryPrice: 94_250 },
    { id: "eth-pullback" },
    { id: "import-1", symbol: "ETHUSDT" },
    { id: "import-2", symbol: "HYPEUSDT" },
  ];

  assert.deepEqual(
    mergeDefaultAndImportedTrades(defaults, saved),
    [defaults[0], defaults[1], defaults[2], saved[3], saved[4]],
  );
  assert.deepEqual(
    mergeDefaultAndImportedTrades(defaults, mergeDefaultAndImportedTrades(defaults, saved)),
    [defaults[0], defaults[1], defaults[2], saved[3], saved[4]],
  );
  assert.equal(mergeDefaultAndImportedTrades(defaults, saved)[0].id, "hype-screenshot-review");
});
