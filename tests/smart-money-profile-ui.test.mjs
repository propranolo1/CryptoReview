import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("导入菜单可以通过聪明钱 URL 自动建用户并完整同步关联成交", async () => {
  const [replay, importer] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SmartMoneyImport.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(replay, /<SmartMoneyImport/);
  assert.match(replay, /handleSmartMoneyImport/);
  assert.match(replay, /fullHistory:\s*true/);
  assert.match(replay, /source:\s*"smart-money-public"/);
  assert.match(replay, /hasCompleteSmartMoneyOrderArchive/);
  assert.match(replay, /allowHistoryOnlyOpenPositions/);
  assert.match(importer, /同步聪明钱/);
  assert.match(importer, /创建独立本地用户/);
  assert.match(importer, /smart-money\/profile/);
});

test("本地接口只读取公开主页资料，不代理需要登录的私有接口", async () => {
  const route = await readFile(
    new URL("../app/api/smart-money/profile/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /friendly\/future\/smart-money\/profile/);
  assert.match(route, /futuresCopyTradePortfolioId/);
  assert.match(route, /"User-Agent"/);
  assert.doesNotMatch(route, /private\/future\/smart-money/);
  assert.doesNotMatch(route, /query-order-history/);
});
