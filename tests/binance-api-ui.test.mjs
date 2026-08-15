import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

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
