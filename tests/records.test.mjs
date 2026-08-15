import assert from "node:assert/strict";
import test from "node:test";

import { createHypeScreenshotTrade } from "../lib/records.mjs";
import { calculateTradePnl } from "../lib/trade.mjs";

test("三张截图生成的 HYPE 复盘使用真实成交时间和完整费用", () => {
  const trade = createHypeScreenshotTrade();

  assert.equal(trade.id, "hype-screenshot-review");
  assert.equal(trade.symbol, "HYPEUSDT");
  assert.equal(trade.side, "long");
  assert.equal(trade.quantity, 22.88);
  assert.equal(trade.entryPrice, 66.431);
  assert.equal(trade.entryTime, "2026-07-16T07:33:17.000Z");
  assert.equal(trade.fee, 0.30398825);
  assert.equal(trade.stopLoss, null);
  assert.equal(trade.takeProfit, null);
  assert.equal(trade.exitPrice, 65.79016);
  assert.equal(trade.exitTime, "2026-07-16T08:04:17.000Z");
  assert.deepEqual(trade.exits, [
    {
      quantity: 22.88,
      exitPrice: 65.79016,
      exitTime: "2026-07-16T08:04:17.000Z",
      fee: 0.75263954,
    },
  ]);
  assert.equal(trade.reportedRealizedPnl, -14.6622);
  assert.equal(trade.marketDataSource, "binance-futures");
  assert.equal(calculateTradePnl(trade).totalPnl, -15.71904699);
});

test("止盈改单记录只保留截图中有证据的 67.179，不虚构止损触发价", () => {
  const trade = createHypeScreenshotTrade();

  assert.deepEqual(trade.riskLevels, [
    {
      id: "tp-10908281928",
      orderId: "10908281928",
      kind: "takeProfit",
      price: 67.179,
      startTime: "2026-07-16T07:35:25.000Z",
      endTime: "2026-07-16T08:04:17.000Z",
      endState: "expired",
    },
  ]);
  assert.equal(trade.riskLevels.some((level) => level.kind === "stopLoss"), false);
  assert.deepEqual(trade.orderIds, {
    entry: "10905798348",
    takeProfit: "10908281928",
    exit: "10909765328",
  });
});
