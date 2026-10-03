import assert from "node:assert/strict";
import { NativeWindow as FakeLoginWindow } from "./fixtures/smart-money-window.mjs";
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
  FakeLoginWindow.onLoad = (window) => window.respond("positions", { success: true, data: { data: positions, total: positions.length } }, { rows: 9 });
  FakeLoginWindow.onDrive = (window, code) => {
    const page = Number(/const page = (\d+)/.exec(code)[1]);
    if (code.includes('"order-history"')) window.respond("order-history", { success: true, data: { data: pages[page - 1] } }, { page });
    return { acted: true };
  };
  const service = createSmartMoneySessionService({
    browserSession: {}, BrowserWindow: FakeLoginWindow,
    now: () => 1_788_000_000_000, syncTimeoutMs: 100, driveIntervalMs: 2,
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
  await service.dispose();
  assert.equal(result.records.at(-1).symbol, "ETHUSDT");
  assert.equal(result.records.at(-1).avgPrice, 3500);
  assert.equal(result.records.at(-1).executedQty, 2);
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
  const driven = [];
  FakeLoginWindow.onLoad = (window) => window.respond("positions", {
    success: true, data: { data: [{ symbol: "BTCUSDT", side: "SHORT", amount: "0.02", entryPrice: "108000", markPrice: "107500" }] },
  }, { rows: 9 });
  FakeLoginWindow.onDrive = (_window, code) => { driven.push(code); return { acted: false }; };
  const service = createSmartMoneySessionService({ browserSession: {}, BrowserWindow: FakeLoginWindow, now: () => 1_788_000_000_000, syncTimeoutMs: 100 });

  const result = await service.syncLatestRecords({
    topTraderId: TOP_TRADER_ID,
    includePositions: true,
    includeLatestRecords: false,
  });

  assert.equal(result.authorizationRequired, false);
  assert.equal(driven.some(code => code.includes('const kind = "order-history"')), false);
  await service.dispose();
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].positionSide, "SHORT");
  assert.deepEqual(result.records, []);
  assert.equal(result.total, 0);
});

test("未登录或登录失效时返回明确授权状态，不把 Binance 原始响应泄漏给界面", async () => {
  FakeLoginWindow.onLoad = (window) => window.respond("positions", { success: false, privateField: "private payload" }, { status: 401 });
  FakeLoginWindow.onDrive = null;
  const service = createSmartMoneySessionService({ browserSession: {}, BrowserWindow: FakeLoginWindow, now: () => 1_788_000_000_000, syncTimeoutMs: 20 });

  const result = await service.syncLatestRecords({ topTraderId: TOP_TRADER_ID });

  assert.deepEqual(result, {
    authorizationRequired: true,
    message: "需要先在 Binance 登录窗口完成登录。",
  });
  assert.doesNotMatch(JSON.stringify(result), /private payload/);
  await service.dispose();
});

test("登录页读取成功后隐藏窗口，并复用已取得的白名单同步结果", async () => {
  FakeLoginWindow.onLoad = window => window.respond("positions", { success: true, data: { data: [{ symbol: "BTCUSDT", side: "SHORT", amount: "0.02", entryPrice: "108000", markPrice: "107500" }] } });
  FakeLoginWindow.onDrive = null;
  const service = createSmartMoneySessionService({ browserSession: {}, BrowserWindow: FakeLoginWindow, now: () => 1_788_000_000_000, authorizationTimeoutMs: 100 });
  const result = await service.authorize({ topTraderId: TOP_TRADER_ID, includeLatestRecords: false });
  assert.equal(result.completed, true);
  assert.equal(result.syncResult.positions[0].positionSide, "SHORT");
  assert.equal(FakeLoginWindow.current.destroyed, false);
  assert.equal(FakeLoginWindow.current.visible, false);
  await service.dispose();
});

test("登录完成前手动关闭窗口会返回取消状态", async () => {
  FakeLoginWindow.onLoad = null;
  FakeLoginWindow.onDrive = null;
  const service = createSmartMoneySessionService({ browserSession: {}, BrowserWindow: FakeLoginWindow, now: () => 1_788_000_000_000 });
  const pending = service.authorize({ topTraderId: TOP_TRADER_ID, includeLatestRecords: false });
  FakeLoginWindow.current.close();
  assert.deepEqual(await pending, { completed: false });
  await service.dispose();
});
