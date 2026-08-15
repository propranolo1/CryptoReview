import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("导入菜单提供公开带单主页同步，并支持手动与自动更新", async () => {
  const [replay, monitor] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/LeadPortfolioMonitor.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(replay, /<LeadPortfolioMonitor/);
  assert.match(replay, /handlePublicLeadSync/);
  assert.match(replay, /config\?\.enabled/);
  assert.match(monitor, /Binance 公开带单主页/);
  assert.match(monitor, /立即同步/);
  assert.match(monitor, /自动更新/);
  assert.match(monitor, /同步到“\{profile\.name\}”/);
});

test("本地接口固定代理 Binance 公开带单数据并完整分页", async () => {
  const route = await readFile(
    new URL("../app/api/copy-trade/lead-portfolio/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /friendly\/future\/copy-trade/);
  assert.match(route, /lead-portfolio\/detail/);
  assert.match(route, /lead-data\/positions/);
  assert.match(route, /lead-portfolio\/order-history/);
  assert.match(route, /pageNumber/);
  assert.match(route, /fullHistory/);
  assert.match(route, /"User-Agent"/);
  assert.match(route, /historyWarnings/);
  assert.match(route, /JSON\.stringify\(value\)/);
});
