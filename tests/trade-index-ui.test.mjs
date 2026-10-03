import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as tokens from "../lib/trade-index.mjs";

test("真实侧栏选择代币、全部和星标后选择对应交易，筛选回调不重置排序", async () => {
  const source = await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8");
  const handlers = source.slice(source.indexOf("  const selectTradeIndex ="), source.indexOf("  const openTradeContextMenu ="));
  const compiled = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const archiveTrades = [
    { id: "btc", symbol: "BTCUSDT", exitTime: "2026-09-28T10:00:00Z" },
    { id: "eth", symbol: "ETHUSDT", exitTime: "2026-09-29T10:00:00Z" },
    { id: "open", symbol: "BTCUSDT", openPosition: {} },
  ];
  let selection = null, selectedId = "eth";
  const makeHandlers = () => new Function("archiveTrades", "starredTrades", "STARRED_TRADE_FILTER", "filterTradesByToken", "setTradeContextMenu", "setSelectedTradeIndex", "selectTrade", `${compiled}; return { selectTradeIndex };`)(
    archiveTrades, [archiveTrades[1]], "starred", tokens.filterTradesByToken,
    () => {}, (value) => { selection = value; }, (value) => { selectedId = value; },
  );
  makeHandlers().selectTradeIndex("BTC");
  assert.equal(selection, "BTC");
  assert.equal(selectedId, "btc");
  makeHandlers().selectTradeIndex("starred");
  assert.equal(selectedId, "eth");
  makeHandlers().selectTradeIndex(null);
  assert.equal(selectedId, "btc");
  makeHandlers().selectTradeIndex("ETH");
  assert.equal(selectedId, "eth");
  assert.equal(selection, "ETH");
  assert.doesNotMatch(handlers, /setTradeSortBy|setTradeSortDirection/);
  assert.match(source, /summarizeTradeListByToken\(archiveTrades\)/);
  assert.match(source, /tokens=\{tokenGroups\}/);
  assert.match(source, /onTokenChange=\{selectTradeIndex\}/);
});
