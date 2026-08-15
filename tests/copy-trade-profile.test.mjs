import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTradeProfiles } from "../lib/trade-profiles.mjs";

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
