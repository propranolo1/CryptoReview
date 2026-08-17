import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicLeadOpenPositions,
  createPublicLeadOrderRecords,
  diffPublicLeadSnapshots,
  extractLeadPortfolioId,
  normalizePublicLeadSnapshot,
} from "../lib/copy-trade-monitor.mjs";
import {
  mergeBinanceOrderRecords,
  reconstructBinanceUsdmReplays,
} from "../lib/binance-orders.mjs";

const PORTFOLIO_ID = "4844930989142068736";
const PROFILE = {
  profileId: "profile-xiaohong",
  profileName: "小洪",
};

test("只接受 Binance 公开带单主页链接或纯 portfolioId", () => {
  assert.equal(
    extractLeadPortfolioId(
      `https://www.binance.com/zh-CN/copy-trading/lead-details/${PORTFOLIO_ID}?ref=copy`,
    ),
    PORTFOLIO_ID,
  );
  assert.equal(extractLeadPortfolioId(PORTFOLIO_ID), PORTFOLIO_ID);
  assert.throws(
    () => extractLeadPortfolioId(`https://example.com/lead-details/${PORTFOLIO_ID}`),
    /Binance/,
  );
  assert.throws(() => extractLeadPortfolioId("not-a-link"), /带单主页/);
});

test("公开成交转换为稳定订单，重复轮询不会重复保存", () => {
  const payload = createPayload([
    leadOrder({
      symbol: "PUMPUSDT",
      side: "BUY",
      positionSide: "LONG",
      executedQty: 921_365,
      avgPrice: 0.001637,
      totalPnl: 0,
      orderUpdateTime: 1_784_299_317_000,
    }),
  ]);

  const first = createPublicLeadOrderRecords(payload, {
    portfolioId: PORTFOLIO_ID,
    ...PROFILE,
  });
  const second = createPublicLeadOrderRecords(payload, {
    portfolioId: PORTFOLIO_ID,
    ...PROFILE,
  });

  assert.equal(first.length, 1);
  assert.equal(first[0].orderId, second[0].orderId);
  assert.equal(first[0].profileId, PROFILE.profileId);
  assert.equal(first[0].profileName, PROFILE.profileName);
  assert.equal(first[0].userId, `copy-public:${PORTFOLIO_ID}`);
  assert.equal(first[0].source, "copy-trade-public");
  assert.deepEqual(first[0].syncSources, ["copy-trade-public"]);
  assert.equal(first[0].reduceOnly, false);
  assert.equal(mergeBinanceOrderRecords(first, second).length, 1);
});

test("多次买入和分批卖出按公开成交价重建为一笔完整复盘", () => {
  const payload = createPayload([
    leadOrder({
      side: "SELL",
      executedQty: 100,
      avgPrice: 1.2,
      totalPnl: 30,
      orderUpdateTime: 1_784_300_200_000,
    }),
    leadOrder({
      side: "SELL",
      executedQty: 100,
      avgPrice: 1.1,
      totalPnl: 10,
      orderUpdateTime: 1_784_300_100_000,
    }),
    leadOrder({
      side: "BUY",
      executedQty: 100,
      avgPrice: 0.8,
      totalPnl: 0,
      orderUpdateTime: 1_784_300_050_000,
    }),
    leadOrder({
      side: "BUY",
      executedQty: 100,
      avgPrice: 1,
      totalPnl: 0,
      orderUpdateTime: 1_784_300_000_000,
    }),
  ]);

  const orders = createPublicLeadOrderRecords(payload, {
    portfolioId: PORTFOLIO_ID,
    ...PROFILE,
  });
  const result = reconstructBinanceUsdmReplays(orders);

  assert.equal(result.warnings.length, 0);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 0.9);
  assert.equal(result.trades[0].entries.length, 2);
  assert.equal(result.trades[0].exits.length, 2);
  assert.equal(result.trades[0].reportedRealizedPnl, 40);
  assert.equal(result.trades[0].profileId, PROFILE.profileId);
  assert.deepEqual(result.trades[0].syncSources, ["copy-trade-public"]);
  assert.equal(result.trades[0].strategy, "Binance 公开带单同步");
});

test("公开当前持仓可与成交历史匹配为未平仓复盘", () => {
  const payload = createPayload(
    [
      leadOrder({
        symbol: "HYPEUSDT",
        side: "BUY",
        positionSide: "LONG",
        executedQty: 26.33,
        avgPrice: 59.013,
        orderUpdateTime: 1_784_298_119_000,
      }),
    ],
    [
      {
        id: "0_HYPEUSDT_LONG",
        symbol: "HYPEUSDT",
        collateral: "USDT",
        positionAmount: "26.33",
        entryPrice: "59.013",
        breakEvenPrice: "59.04",
        markPrice: "60.25",
        unrealizedProfit: "32.52755",
        leverage: 5,
        positionSide: "LONG",
      },
      {
        id: "0_BTCUSDT_BOTH",
        symbol: "BTCUSDT",
        collateral: "USDT",
        positionAmount: "0",
        entryPrice: "0",
        markPrice: "0",
        unrealizedProfit: "0",
        leverage: 5,
        positionSide: "BOTH",
      },
    ],
  );

  const snapshot = normalizePublicLeadSnapshot(payload, {
    portfolioId: PORTFOLIO_ID,
    fetchedAt: "2026-07-31T04:00:00.000Z",
  });
  const positions = createPublicLeadOpenPositions(snapshot, {
    portfolioId: PORTFOLIO_ID,
    ...PROFILE,
  });
  const orders = createPublicLeadOrderRecords(snapshot, {
    portfolioId: PORTFOLIO_ID,
    ...PROFILE,
  });
  const result = reconstructBinanceUsdmReplays(orders, {
    openPositions: positions,
    syncedAt: snapshot.fetchedAt,
  });

  assert.equal(positions.length, 1);
  assert.equal(positions[0].quantity, 26.33);
  assert.equal(positions[0].side, "long");
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitTime, null);
  assert.equal(result.trades[0].openPosition.markPrice, 60.25);
});

test("普通公开带单不能仅凭未闭合成交推定当前仍持仓", () => {
  const payload = createPayload([
    leadOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      positionSide: "LONG",
      executedQty: 0.237,
      avgPrice: 63173.3,
      orderUpdateTime: 1_786_930_401_358,
    }),
  ]);
  const orders = createPublicLeadOrderRecords(payload, {
    portfolioId: PORTFOLIO_ID,
    ...PROFILE,
  });
  const result = reconstructBinanceUsdmReplays(orders, {
    syncedAt: payload.fetchedAt,
    allowHistoryOnlyOpenPositions: true,
  });

  assert.equal(result.trades.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "ambiguous_open_position");
});

test("快照差分只记录仓位变化，不伪造成交价格", () => {
  const previous = {
    fetchedAt: "2026-07-31T04:00:00.000Z",
    positions: [
      { symbol: "BTCUSDT", positionSide: "LONG", quantity: 1, entryPrice: 60_000 },
      { symbol: "SOLUSDT", positionSide: "SHORT", quantity: 10, entryPrice: 150 },
    ],
  };
  const next = {
    fetchedAt: "2026-07-31T04:01:00.000Z",
    positions: [
      { symbol: "BTCUSDT", positionSide: "LONG", quantity: 1.5, entryPrice: 59_500 },
      { symbol: "ETHUSDT", positionSide: "LONG", quantity: 2, entryPrice: 3_500 },
    ],
  };

  assert.deepEqual(
    diffPublicLeadSnapshots(previous, next).map((change) => ({
      kind: change.kind,
      symbol: change.symbol,
      previousQuantity: change.previousQuantity,
      quantity: change.quantity,
    })),
    [
      {
        kind: "increased",
        symbol: "BTCUSDT",
        previousQuantity: 1,
        quantity: 1.5,
      },
      {
        kind: "opened",
        symbol: "ETHUSDT",
        previousQuantity: 0,
        quantity: 2,
      },
      {
        kind: "closed",
        symbol: "SOLUSDT",
        previousQuantity: 10,
        quantity: 0,
      },
    ],
  );
});

function createPayload(orderList, positions = []) {
  return {
    portfolioId: PORTFOLIO_ID,
    fetchedAt: "2026-07-31T04:00:00.000Z",
    detail: {
      leadPortfolioId: PORTFOLIO_ID,
      nickname: "示例带单员",
      status: "ACTIVE",
    },
    positions,
    orderHistory: {
      total: orderList.length,
      list: orderList,
    },
  };
}

function leadOrder(overrides = {}) {
  return {
    symbol: "PUMPUSDT",
    baseAsset: "PUMP",
    quoteAsset: "USDT",
    side: "BUY",
    type: "MARKET",
    positionSide: "LONG",
    executedQty: 100,
    avgPrice: 1,
    totalPnl: 0,
    orderUpdateTime: 1_784_300_000_000,
    orderTime: 1_784_300_000_000,
    ...overrides,
  };
}
