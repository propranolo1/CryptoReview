import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("导入菜单可以通过聪明钱 URL 自动建用户并优先同步共享仓位与操作记录", async () => {
  const [replay, importer, monitor, preload, desktopTypes] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SmartMoneyImport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/LeadPortfolioMonitor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../app/desktop-api.d.ts", import.meta.url), "utf8"),
  ]);

  assert.match(replay, /<SmartMoneyImport/);
  assert.match(replay, /handleSmartMoneyImport/);
  assert.match(replay, /syncSmartMoneyLatestRecords/);
  assert.match(replay, /positions:\s*latestResult\.positions/);
  assert.match(replay, /smartMoneySource\?\.sharingPosition/);
  assert.match(replay, /includePositions:\s*smartMoneySource\.sharingPosition/);
  assert.match(replay, /includeLatestRecords:\s*smartMoneySource\.sharingLatestRecord/);
  assert.match(
    replay,
    /authorizeSmartMoney:\s*snapshot\.sharingPosition\s*\|\|\s*snapshot\.sharingLatestRecord/,
  );
  assert.match(replay, /authorizeSmartMoney/);
  assert.match(replay, /syncResult/);
  assert.match(
    replay,
    /authorizeSmartMoney\([\s\S]*includePositions:\s*smartMoneySource\.sharingPosition[\s\S]*includeLatestRecords:\s*smartMoneySource\.sharingLatestRecord/,
  );
  assert.match(replay, /fullHistory:\s*true/);
  assert.match(replay, /source:\s*"smart-money-public"/);
  assert.match(replay, /hasCompleteSmartMoneyOrderArchive/);
  assert.match(replay, /allowHistoryOnlyOpenPositions/);
  assert.match(replay, /!usingSmartMoneyLatestRecords/);
  assert.match(importer, /同步聪明钱/);
  assert.match(importer, /创建独立本地用户/);
  assert.match(importer, /smart-money\/profile/);
  assert.match(importer, /最近 30 天/);
  assert.match(importer, /登录成功后会自动继续同步/);
  assert.match(monitor, /profile\.smartMoneySource\?\.sourceUrl\s*\?\?/);
  assert.match(monitor, /登录并同步聪明钱/);
  assert.match(preload, /desktop:smart-money-authorize/);
  assert.match(preload, /desktop:smart-money-sync-latest-records/);
  assert.match(preload, /includePositions/);
  assert.match(preload, /includeLatestRecords/);
  assert.match(desktopTypes, /authorizeSmartMoney/);
  assert.match(desktopTypes, /syncSmartMoneyLatestRecords/);
  assert.match(desktopTypes, /includePositions:\s*boolean/);
  assert.match(desktopTypes, /includeLatestRecords:\s*boolean/);
  assert.match(desktopTypes, /positions:\s*SmartMoneyPosition\[\]/);
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
