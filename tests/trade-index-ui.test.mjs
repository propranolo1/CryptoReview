import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as tokens from "../lib/trade-index.mjs";
import * as dates from "../lib/performance.mjs";

test("真实侧栏点击代币、日期、全部和星标后选择对应交易，切换索引清除旧筛选", async () => {
  const source = await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8");
  const handlers = source.slice(source.indexOf("  const selectTradeIndex ="), source.indexOf("  const openTradeContextMenu ="));
  const compiled = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const archiveTrades = [
    { id: "btc", symbol: "BTCUSDT", exitTime: "2026-09-28T10:00:00Z" },
    { id: "eth", symbol: "ETHUSDT", exitTime: "2026-09-29T10:00:00Z" },
    { id: "open", symbol: "BTCUSDT", openPosition: {} },
  ];
  let selection = "2026-09-29", selectedId = "eth", mode = "date";
  const makeHandlers = () => new Function("tradeIndexMode", "archiveTrades", "starredTrades", "STARRED_TRADE_FILTER", "filterTradesByToken", "filterTradesByCloseDate", "setTradeContextMenu", "setSelectedTradeIndex", "selectTrade", "setTradeIndexMode", `${compiled}; return { selectTradeIndex, selectTradeIndexMode };`)(
    mode, archiveTrades, [archiveTrades[1]], "starred", tokens.filterTradesByToken, dates.filterTradesByCloseDate,
    () => {}, (value) => { selection = value; }, (value) => { selectedId = value; }, (value) => { mode = value; },
  );
  makeHandlers().selectTradeIndexMode("token");
  assert.equal(selection, null);
  makeHandlers().selectTradeIndex("BTC");
  assert.equal(selection, "BTC");
  assert.equal(selectedId, "btc");
  makeHandlers().selectTradeIndex("starred");
  assert.equal(selectedId, "eth");
  makeHandlers().selectTradeIndex(null);
  assert.equal(selectedId, "btc");
  makeHandlers().selectTradeIndexMode("date");
  makeHandlers().selectTradeIndex("2026-09-29");
  assert.equal(selectedId, "eth");
  assert.match(source, /tradeIndexMode === "date" \? closeDateGroups\.map/);
  assert.match(source, /tokenGroups\.map/);
  assert.match(source, /groupTradesByToken\(archiveTrades\)/);
  assert.match(source, /按日期/);
  assert.match(source, /按代币/);
});
