import assert from "node:assert/strict";
import test from "node:test";

import {
  copyTradeProfileId,
  upsertPublicLeadTradeProfile,
} from "../lib/copy-trade-monitor.mjs";
import {
  DEFAULT_TRADE_PROFILE_ID,
  normalizeTradeProfiles,
} from "../lib/trade-profiles.mjs";

const PUBLIC_LEAD_CONFIG = {
  enabled: true,
  sourceUrl:
    "https://www.binance.com/zh-CN/copy-trading/lead-details/4844930989142068736",
  portfolioId: "4844930989142068736",
  intervalSeconds: 60,
};

test("公开带单监控配置跟随复盘用户保存，并过滤无效字段", () => {
  const [profile] = normalizeTradeProfiles([
    {
      id: "profile-self",
      name: "我的账户",
      createdAt: "2026-07-01T00:00:00.000Z",
      copyTradeMonitor: {
        enabled: true,
        sourceUrl:
          "https://www.binance.com/zh-CN/copy-trading/lead-details/4844930989142068736",
        portfolioId: "4844930989142068736",
        intervalSeconds: 60,
        nickname: "示例带单员",
        lastSyncedAt: "2026-07-31T04:00:00.000Z",
        lastOrderTime: 1_784_300_000_000,
        lastSnapshot: {
          fetchedAt: "2026-07-31T04:00:00.000Z",
          positions: [
            {
              symbol: "BTCUSDT",
              positionSide: "LONG",
              quantity: 0.5,
              entryPrice: 60_000,
            },
          ],
        },
        unexpected: "drop-me",
      },
    },
  ]);

  assert.deepEqual(profile.copyTradeMonitor, {
    enabled: true,
    sourceUrl:
      "https://www.binance.com/zh-CN/copy-trading/lead-details/4844930989142068736",
    portfolioId: "4844930989142068736",
    intervalSeconds: 60,
    nickname: "示例带单员",
    lastSyncedAt: "2026-07-31T04:00:00.000Z",
    lastOrderTime: 1_784_300_000_000,
    lastSnapshot: {
      fetchedAt: "2026-07-31T04:00:00.000Z",
      positions: [
        {
          symbol: "BTCUSDT",
          positionSide: "LONG",
          quantity: 0.5,
          entryPrice: 60_000,
        },
      ],
    },
  });
});

test("无效监控配置不会污染用户存档", () => {
  const [profile] = normalizeTradeProfiles([
    {
      id: "profile-self",
      name: "我的账户",
      createdAt: "2026-07-01T00:00:00.000Z",
      copyTradeMonitor: {
        enabled: true,
        sourceUrl: "https://example.com/123",
        portfolioId: "123",
        intervalSeconds: 1,
      },
    },
  ]);

  assert.equal(profile.copyTradeMonitor, undefined);
});

test("公开带单同步会像聪明钱一样创建并复用独立复盘用户", () => {
  const profiles = normalizeTradeProfiles([{
    id: DEFAULT_TRADE_PROFILE_ID,
    name: "我的账户",
    createdAt: "2026-07-01T00:00:00.000Z",
    copyTradeMonitor: PUBLIC_LEAD_CONFIG,
  }]);

  const first = upsertPublicLeadTradeProfile(
    profiles,
    PUBLIC_LEAD_CONFIG,
    { nickname: "稳健交易员", now: 1_785_427_200_000 },
  );
  const second = upsertPublicLeadTradeProfile(
    first.profiles,
    { ...PUBLIC_LEAD_CONFIG, intervalSeconds: 300 },
    { nickname: "稳健交易员", now: 1_785_513_600_000 },
  );

  assert.equal(first.created, true);
  assert.equal(first.profile.id, copyTradeProfileId(PUBLIC_LEAD_CONFIG.portfolioId));
  assert.equal(first.profile.name, "稳健交易员");
  assert.notEqual(first.profile.id, DEFAULT_TRADE_PROFILE_ID);
  assert.equal(second.created, false);
  assert.equal(second.profile.id, first.profile.id);
  assert.equal(second.profile.createdAt, first.profile.createdAt);
  assert.equal(second.profile.copyTradeMonitor.intervalSeconds, 300);
  assert.equal(
    second.profiles.filter((profile) => profile.id === first.profile.id).length,
    1,
  );
});
