import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("交易回放接收 OKX 同步结果并按账户隔离重建", async () => {
  const component = await readFile(
    new URL("app/components/TradeReplay.tsx", projectUrl),
    "utf8",
  );

  assert.match(component, /mergeOkxApiReplays/);
  assert.match(component, /handleOkxApiSync/);
  assert.match(component, /result\.accountId/);
  assert.match(component, /order\.userId === result\.accountId/);
  assert.match(component, /onOkxSync=\{handleOkxApiSync\}/);
  assert.match(component, /"okx-api": "OKX API"/);
  assert.match(component, /订单来源 OKX，行情来源 Binance U 本位公共行情/);
  assert.match(component, /orderArchiveRef\.current/);
  assert.match(component, /mergeIntoOrderArchive/);
  assert.match(
    component,
    /typeof warning === "string" \? warning : warning\.message/,
  );
});
