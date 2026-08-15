import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SMART_MONEY_PROFILE_ID,
  DEFAULT_SMART_MONEY_SOURCE_URL,
  createSmartMoneyTradeProfile,
  extractSmartMoneyProfileId,
  normalizeSmartMoneyProfileSnapshot,
  upsertSmartMoneyTradeProfile,
} from "../lib/smart-money-profile.mjs";
import {
  createPublicLeadOrderRecords,
} from "../lib/copy-trade-monitor.mjs";
import {
  reconstructBinanceUsdmReplays,
} from "../lib/binance-orders.mjs";
import { normalizeTradeProfiles } from "../lib/trade-profiles.mjs";

const TOP_TRADER_ID = "5078319056891617536";
const LEAD_PORTFOLIO_ID = "5090588047188778241";

test("只接受 Binance 官方聪明钱主页链接或纯 topTraderId", () => {
  assert.equal(extractSmartMoneyProfileId(DEFAULT_SMART_MONEY_SOURCE_URL), TOP_TRADER_ID);
  assert.equal(extractSmartMoneyProfileId(TOP_TRADER_ID), TOP_TRADER_ID);
  assert.throws(
    () => extractSmartMoneyProfileId(`https://example.com/smart-money/profile/${TOP_TRADER_ID}`),
    /Binance/,
  );
  assert.throws(() => extractSmartMoneyProfileId("not-a-link"), /聪明钱主页/);
});

test("公开主页资料会提取关联带单档案并生成独立复盘用户", () => {
  const snapshot = normalizeSmartMoneyProfileSnapshot(createProfilePayload(), {
    topTraderId: TOP_TRADER_ID,
    fetchedAt: "2026-08-14T04:00:00.000Z",
  });

  assert.equal(snapshot.topTraderId, TOP_TRADER_ID);
  assert.equal(snapshot.traderName, "不停梭-");
  assert.equal(snapshot.accountName, "1万U不停梭挑战");
  assert.equal(snapshot.leadPortfolioId, LEAD_PORTFOLIO_ID);
  assert.equal(snapshot.sharingLatestRecord, true);

  const profile = createSmartMoneyTradeProfile([], snapshot);
  assert.equal(profile.id, DEFAULT_SMART_MONEY_PROFILE_ID);
  assert.equal(profile.name, "不停梭- · 1万U不停梭挑战");
  assert.equal(profile.smartMoneySource.topTraderId, TOP_TRADER_ID);
  assert.equal(profile.copyTradeMonitor.portfolioId, LEAD_PORTFOLIO_ID);
  assert.equal(profile.copyTradeMonitor.enabled, true);
});

test("同一个聪明钱 URL 重复导入只更新原用户，不会创建重复档案", () => {
  const snapshot = normalizeSmartMoneyProfileSnapshot(createProfilePayload(), {
    topTraderId: TOP_TRADER_ID,
    fetchedAt: "2026-08-14T04:00:00.000Z",
  });
  const first = upsertSmartMoneyTradeProfile(normalizeTradeProfiles([]), snapshot);
  const second = upsertSmartMoneyTradeProfile(first.profiles, {
    ...snapshot,
    fetchedAt: "2026-08-14T05:00:00.000Z",
  });

  assert.equal(first.created, false);
  assert.equal(second.created, false);
  assert.equal(
    second.profiles.filter((profile) => profile.id === DEFAULT_SMART_MONEY_PROFILE_ID).length,
    1,
  );
  assert.equal(second.profile.smartMoneySource.lastResolvedAt, "2026-08-14T05:00:00.000Z");
});

test("关联公开成交保留聪明钱来源，并按现有 U 本位逻辑生成回放", () => {
  const payload = {
    portfolioId: LEAD_PORTFOLIO_ID,
    fetchedAt: "2026-08-14T04:00:00.000Z",
    detail: { leadPortfolioId: LEAD_PORTFOLIO_ID, nickname: "不停梭-" },
    positions: [],
    orderHistory: {
      total: 2,
      list: [
        {
          symbol: "BTCUSDT",
          side: "BUY",
          type: "MARKET",
          positionSide: "LONG",
          executedQty: 0.01,
          avgPrice: 100000,
          totalPnl: 0,
          orderUpdateTime: 1786672800000,
          orderTime: 1786672800000,
        },
        {
          symbol: "BTCUSDT",
          side: "SELL",
          type: "LIMIT",
          positionSide: "LONG",
          executedQty: 0.01,
          avgPrice: 101000,
          totalPnl: 10,
          orderUpdateTime: 1786676400000,
          orderTime: 1786676400000,
        },
      ],
    },
  };
  const orders = createPublicLeadOrderRecords(payload, {
    portfolioId: LEAD_PORTFOLIO_ID,
    profileId: DEFAULT_SMART_MONEY_PROFILE_ID,
    profileName: "不停梭- · 1万U不停梭挑战",
    source: "smart-money-public",
    sourceIdentity: TOP_TRADER_ID,
  });
  const reconstruction = reconstructBinanceUsdmReplays(orders);

  assert.equal(orders[0].source, "smart-money-public");
  assert.equal(orders[0].userId, `smart-money:${TOP_TRADER_ID}`);
  assert.deepEqual(orders[0].syncSources, ["smart-money-public"]);
  assert.equal(reconstruction.trades.length, 1);
  assert.equal(reconstruction.trades[0].strategy, "Binance 聪明钱同步");
  assert.deepEqual(reconstruction.trades[0].syncSources, ["smart-money-public"]);
});

test("没有关联公开带单档案时明确拒绝伪造操作记录", () => {
  assert.throws(
    () => normalizeSmartMoneyProfileSnapshot({
      data: {
        topTraderId: TOP_TRADER_ID,
        traderName: "仅展示表现",
        futuresCopyTradePortfolioId: null,
      },
      success: true,
    }, { topTraderId: TOP_TRADER_ID }),
    /没有关联可公开读取的合约带单档案/,
  );
});

function createProfilePayload() {
  return {
    code: "000000",
    success: true,
    data: {
      topTraderId: TOP_TRADER_ID,
      traderName: "不停梭-",
      accountName: "1万U不停梭挑战",
      introduction: "Track my real-time futures trades and performance over time.",
      sharingPosition: true,
      sharingPositionHistory: true,
      sharingLatestRecord: true,
      futuresCopyTradePortfolioId: LEAD_PORTFOLIO_ID,
    },
  };
}
