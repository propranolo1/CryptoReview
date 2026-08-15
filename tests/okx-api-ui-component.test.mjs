import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("交易所 API 弹窗在一个入口内提供 Binance 与 OKX 页签", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("app/components/BinanceApiConnect.tsx", projectUrl), "utf8"),
    readFile(new URL("app/components/BinanceApiConnect.module.css", projectUrl), "utf8"),
  ]);

  assert.match(component, /onOkxSync:\s*\(result:\s*OkxApiSyncResult\)/);
  assert.match(component, /aria-label="连接交易所 API"/);
  assert.doesNotMatch(component, /<span>交易所 API<\/span>/);
  assert.match(component, /role="tablist"/);
  assert.match(component, /role="tab"/);
  assert.match(component, />Binance</);
  assert.match(component, />OKX</);
  assert.match(styles, /\.tabs/);
  assert.match(styles, /\.activeTab/);
});

test("OKX 凭证、区域和固定桌面 API 均在组件内受控", async () => {
  const component = await readFile(
    new URL("app/components/BinanceApiConnect.tsx", projectUrl),
    "utf8",
  );

  assert.match(component, /getOkxApiStatus/);
  assert.match(component, /configureOkxApi/);
  assert.match(component, /syncOkxOrders/);
  assert.match(component, /removeOkxApi/);
  assert.ok(
    (component.match(/type="password"/g) ?? []).length >= 5,
    "Binance 两项与 OKX 三项凭证都必须使用密码输入框",
  );
  assert.match(component, /value="global"/);
  assert.match(component, /value="us"/);
  assert.match(component, /value="eea"/);
  assert.match(component, /setOkxApiKey\(""\)/);
  assert.match(component, /setOkxApiSecret\(""\)/);
  assert.match(component, /setOkxPassphrase\(""\)/);
});

test("顶部更新会并行同步所有已连接交易所并分别保留结果", async () => {
  const component = await readFile(
    new URL("app/components/BinanceApiConnect.tsx", projectUrl),
    "utf8",
  );

  assert.match(component, /Promise\.allSettled/);
  assert.match(component, /binanceStatus\.configured/);
  assert.match(component, /okxStatus\.configured/);
  assert.match(component, /setBinanceFeedback/);
  assert.match(component, /setOkxFeedback/);
  assert.match(component, /更新 Binance 数据/);
  assert.match(component, /更新 OKX 数据/);
});
