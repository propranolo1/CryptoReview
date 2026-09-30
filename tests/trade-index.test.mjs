import assert from "node:assert/strict";
import test from "node:test";
import { groupTradesByToken, filterTradesByToken, getTradeToken } from "../lib/trade-index.mjs";
import { filterRecordsByTradeProfile } from "../lib/trade-profiles.mjs";

test("代币索引合并同币不同计价交易对，并保留中文和合约数量前缀", () => {
  const trades = [
    { id: "a", symbol: "btc/usdt" }, { id: "b", symbol: "BTCUSDC" },
    { id: "c", symbol: "ETHUSDT", openPosition: {} },
    { id: "d", symbol: "牛来USDT" }, { id: "e", symbol: "1000PEPEUSDT" },
  ];
  const groups = groupTradesByToken(trades);
  assert.equal(groups.find((group) => group.token === "BTC").count, 2);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), 5);
  assert.deepEqual(filterTradesByToken(trades, "BTC").map((trade) => trade.id), ["a", "b"]);
  assert.deepEqual(filterTradesByToken(trades, "ETH").map((trade) => trade.id), ["c"]);
  assert.deepEqual(filterTradesByToken(trades, null), trades);
  assert.equal(getTradeToken("牛来USDT"), "牛来");
  assert.equal(getTradeToken("1000PEPEUSDT"), "1000PEPE");
  assert.equal(getTradeToken("ETH"), "ETH");
  assert.deepEqual(groupTradesByToken([]), []);
});

test("代币索引只读取当前复盘用户，切换代币后没有其他币种混入", () => {
  const trades = [
    { id: "a", profileId: "profile-a", symbol: "BTCUSDT" },
    { id: "b", profileId: "profile-b", symbol: "SOLUSDT" },
    { id: "c", profileId: "profile-a", symbol: "ETHUSDT" },
  ];
  const current = filterRecordsByTradeProfile(trades, "profile-a");
  assert.deepEqual(groupTradesByToken(current).map((group) => group.token), ["BTC", "ETH"]);
  assert.deepEqual(filterTradesByToken(current, "SOL"), []);
});
