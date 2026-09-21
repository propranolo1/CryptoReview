import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const projectUrl = new URL("../", import.meta.url);

test("软件跨日保持打开后点击快速更新仍读取到当前时间，不沿用弹窗旧结束日期", async () => {
  const source = await readFile(new URL("app/components/BinanceApiConnect.tsx", projectUrl), "utf8");
  const handler = source.slice(source.indexOf("const quickSync = async"), source.indexOf("const removeBinanceConnection"));
  const helpers = source.slice(source.indexOf("function getSyncRange"));
  const now = Date.parse("2026-09-21T02:00:00Z");
  let captured;
  const noop = () => {};
  const code = ts.transpileModule(`${helpers}\n${handler}\nquickSync();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await runInNewContext(code, {
    Date: class extends Date { static now() { return now; } },
    window: { cryptoReviewDesktop: {} }, hasConnectedExchange: true,
    startDate: "2026-09-01", endDate: "2026-09-14",
    binanceStatus: { configured: true }, okxStatus: { configured: false },
    syncBinanceData: async (_api, range) => { captured = range; return "成功"; },
    setBusy: noop, setGeneralError: noop, setBinanceFeedback: noop, setOkxFeedback: noop,
    setQuickSummary: noop, setExchangeProgress: noop, setOpen: noop,
  });
  assert.equal(captured.endTime, now);
  assert.equal(captured.incremental, true);
});

test("桌面端提供 Binance API 连接、加密提示和基础/条件单同步入口", async () => {
  const [component, styles, replay] = await Promise.all([
    readFile(new URL("app/components/BinanceApiConnect.tsx", projectUrl), "utf8"),
    readFile(new URL("app/components/BinanceApiConnect.module.css", projectUrl), "utf8"),
    readFile(new URL("app/components/TradeReplay.tsx", projectUrl), "utf8"),
  ]);

  assert.match(component, /Binance API/);
  assert.match(component, /configureBinanceApi/);
  assert.match(component, /syncBinanceOrders/);
  assert.match(component, /removeBinanceApi/);
  assert.match(component, /type="password"/);
  assert.match(component, /只读同步/);
  assert.match(component, /系统安全存储/);
  assert.match(component, /基础委托/);
  assert.match(component, /条件单/);
  assert.match(component, /自动发现/);
  assert.doesNotMatch(component, /交易对（逗号分隔）/);
  assert.doesNotMatch(component, /symbolText/);
  assert.match(component, /更新 Binance 数据/);
  assert.match(component, /quickSync/);
  assert.match(component, /incremental:\s*true/);
  assert.match(component, /onExchangeSyncProgress/);
  assert.match(component, /exchangeProgress/);
  assert.match(styles, /\.syncProgress/);
  assert.match(component, /getBinanceApiStatus/);
  assert.match(styles, /\.triggerGroup/);
  assert.match(styles, /\.updateButton/);
  assert.match(replay, /BinanceApiConnect/);
  assert.match(replay, /handleBinanceApiSync/);
  assert.match(replay, /mergeBinanceApiReplays/);
  assert.match(replay, /openPositions:\s*assignTradeProfile\(\s*result\.openPositions/s);
  assert.match(replay, /result\.fillCount/);
  assert.match(replay, /result\.openPositionCount/);
});
