import assert from "node:assert/strict";
import test from "node:test";

import {
  createSmartMoneySessionService,
  isAllowedBinanceNavigation,
} from "../desktop/smart-money-session.mjs";

const TOP_TRADER_ID = "5146419622540980737";

test("聪明钱网页登录会话只允许 Binance HTTPS 页面", () => {
  assert.equal(
    isAllowedBinanceNavigation(
      `https://www.binance.com/zh-CN/smart-money/profile/${TOP_TRADER_ID}`,
    ),
    true,
  );
  assert.equal(isAllowedBinanceNavigation("https://accounts.binance.com/zh-CN/login"), true);
  assert.equal(isAllowedBinanceNavigation("http://www.binance.com/zh-CN/login"), false);
  assert.equal(isAllowedBinanceNavigation("https://binance.com.example.org/login"), false);
});

test("登录后的当前仓位与最新操作记录会一起同步，并过滤无效数据", async () => {
  const requestedUrls = [];
  const positions = [
    {
      symbol: "BTCUSDT",
      positionSide: "SHORT",
      amount: "0.062",
      entryPrice: "79490.8",
      breakEvenPrice: "79458.2",
      markPrice: "80735.5",
      unrealizedProfit: "-77.1714",
      collateral: "USDT",
    },
    {
      symbol: "ETHUSDT",
      positionSide: "LONG",
      amount: "0",
      entryPrice: "3500",
    },
  ];
  const pages = [
    Array.from({ length: 10 }, (_, index) => ({
      symbol: index === 9 ? "bad symbol" : "BTCUSDT",
      side: index % 2 === 0 ? "BUY" : "SELL",
      positionSide: "LONG",
      avgPrice: 100_000 + index,
      executedQty: "0.01",
      executedQuoteQty: "1000",
      updateTime: 1_786_800_000_000 + index,
    })),
    [
      {
        symbol: "BTCUSDT",
        side: "BUY",
        positionSide: "LONG",
        avgPrice: 100_000,
        executedQty: "0.01",
        executedQuoteQty: "1000",
        updateTime: 1_786_800_000_000,
      },
      {
        symbol: "ETHUSDT",
        side: "SELL",
        positionSide: "SHORT",
        avgPrice: 0,
        executedQty: "2",
        executedQuoteQty: "7000",
        updateTime: 1_786_800_100_000,
      },
    ],
  ];
  const browserSession = {
    fetch: async (input, init) => {
      const url = new URL(input);
      requestedUrls.push({ url, init });
      if (url.pathname.endsWith("/query-positions")) {
        return new Response(
          JSON.stringify({ success: true, data: { data: positions, total: positions.length } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      const page = Number(url.searchParams.get("page"));
      return new Response(JSON.stringify({ success: true, data: { data: pages[page - 1] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const service = createSmartMoneySessionService({
    browserSession,
    BrowserWindow: class {},
    now: () => 1_788_000_000_000,
  });

  const result = await service.syncLatestRecords({ topTraderId: TOP_TRADER_ID });

  assert.equal(result.authorizationRequired, false);
  assert.equal(result.marketType, "UM");
  assert.deepEqual(result.positions, [
    {
      symbol: "BTCUSDT",
      positionAmount: 0.062,
      positionSide: "SHORT",
      entryPrice: 79490.8,
      breakEvenPrice: 79458.2,
      markPrice: 80735.5,
      unrealizedProfit: -77.1714,
      marginAsset: "USDT",
    },
  ]);
  assert.equal(result.records.length, 10);
  assert.equal(result.records.at(-1).symbol, "ETHUSDT");
  assert.equal(result.records.at(-1).avgPrice, 3500);
  assert.equal(result.records.at(-1).executedQty, 2);
  assert.equal(requestedUrls.length, 3);
  const positionRequest = requestedUrls.find(({ url }) =>
    url.pathname.endsWith("/query-positions"),
  );
  assert.ok(positionRequest);
  assert.equal(positionRequest.url.searchParams.get("topTraderId"), TOP_TRADER_ID);
  assert.equal(positionRequest.url.searchParams.get("marketType"), "UM");
  assert.equal(positionRequest.url.searchParams.get("rows"), "9");
  assert.equal(positionRequest.init.credentials, "include");
  assert.equal(positionRequest.init.useSessionCookies, true);
  assert.deepEqual(Object.keys(result.records[0]).sort(), [
    "avgPrice",
    "executedQty",
    "executedQuoteQty",
    "positionSide",
    "side",
    "symbol",
    "updateTime",
  ]);
});

test("主页只分享当前仓位时不请求未分享的最新操作记录", async () => {
  const requestedPaths = [];
  const browserSession = {
    fetch: async (input) => {
      const url = new URL(input);
      requestedPaths.push(url.pathname);
      if (!url.pathname.endsWith("/query-positions")) {
        throw new Error("不应请求未分享的最新操作记录");
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          data: [{
            symbol: "BTCUSDT",
            side: "SHORT",
            amount: "0.02",
            entryPrice: "108000",
            markPrice: "107500",
          }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const service = createSmartMoneySessionService({
    browserSession,
    BrowserWindow: class {},
    now: () => 1_788_000_000_000,
  });

  const result = await service.syncLatestRecords({
    topTraderId: TOP_TRADER_ID,
    includePositions: true,
    includeLatestRecords: false,
  });

  assert.equal(result.authorizationRequired, false);
  assert.deepEqual(requestedPaths, [
    "/bapi/asset/v1/private/future/smart-money/profile/query-positions",
  ]);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].positionSide, "SHORT");
  assert.deepEqual(result.records, []);
  assert.equal(result.total, 0);
});

test("未登录或登录失效时返回明确授权状态，不把 Binance 原始响应泄漏给界面", async () => {
  const browserSession = {
    fetch: async () => new Response("private payload", { status: 401 }),
  };
  const service = createSmartMoneySessionService({
    browserSession,
    BrowserWindow: class {},
    now: () => 1_788_000_000_000,
  });

  const result = await service.syncLatestRecords({ topTraderId: TOP_TRADER_ID });

  assert.deepEqual(result, {
    authorizationRequired: true,
    message: "需要先在 Binance 登录窗口完成登录。",
  });
  assert.doesNotMatch(JSON.stringify(result), /private payload/);
});
