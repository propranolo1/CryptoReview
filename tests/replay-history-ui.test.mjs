import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("回放图表监听历史边缘，补历史不重置回放时间并能取消过期请求", async () => {
  const source = await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8");
  assert.match(source, /subscribeVisibleLogicalRangeChange/);
  assert.match(source, /unsubscribeVisibleLogicalRangeChange/);
  assert.doesNotMatch(source, /fixLeftEdge: true/);
  assert.match(source, /historyLoader\.cancel\(\)/);
  assert.match(source, /cursor: current\.cursor \+ result\.addedCount/);
  assert.match(source, /setEntryIndex\(\(current\) => current \+ result\.addedCount\)/);
  assert.match(source, /shiftReplayHistoryRange/);
  assert.doesNotMatch(source, /safeCursor <= entryIndex \|\| previousCursor < 0/);
  assert.match(source, /重试加载历史/);
});

test("回放和视频使用一致的成交箭头聚合规则", async () => {
  for (const file of ["app/components/TradeReplay.tsx", "app/lib/replay-video-renderer.ts"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /buildReplayTradeMarkers\(/);
    assert.doesNotMatch(source, /stackCountByCandleAndSide/);
  }
});
