import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("交易自动同步不以 exits 数组引用作为行情重载条件", async () => {
  const component = await readFile(
    new URL("../app/components/TradeReplay.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    component,
    /const replayMarketDataKey = buildReplayMarketDataKey\(trade, frame\);/,
  );
  assert.match(component, /\}, \[replayMarketDataKey\]\);/);
  assert.doesNotMatch(
    component,
    /\[frame, trade\.entryTime, trade\.exits, trade\.id, trade\.marketDataSource, trade\.symbol\]/,
  );
});

test("回放切换周期会保存当前时间和播放状态并在新周期恢复", async () => {
  const component = await readFile(
    new URL("../app/components/TradeReplay.tsx", import.meta.url),
    "utf8",
  );

  assert.match(component, /pendingTimeframeReplayRef/);
  assert.match(component, /timeMs:\s*currentReplayTimeMs/);
  assert.match(component, /playing/);
  assert.match(component, /locateReplayFrameAtTime\(/);
  assert.match(component, /onClick=\{\(\) => changeReplayTimeframe\(item\)\}/);
  assert.doesNotMatch(component, /onClick=\{\(\) => setFrame\(item\)\}/);
});

test("回放页移除右侧详情栏并把盈亏与导出入口放入扩展后的主图工具栏", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(component, /<aside className="review-sidebar">/);
  assert.doesNotMatch(component, />K 线回放</);
  assert.doesNotMatch(component, /OI 已同步/);
  assert.match(component, /className=\{`replay-toolbar-pnl \$\{pnlTone\}`\}/);
  assert.match(component, /<ReplayVideoExport[\s\S]*?<details className="indicator-picker">/);
  assert.match(styles, /grid-template-columns:\s*238px minmax\(0, 1fr\)/);
  assert.match(styles, /max-width:\s*1920px/);
});
