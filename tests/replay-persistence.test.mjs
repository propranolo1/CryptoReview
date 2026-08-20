import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("API 更新完成前通过单次原子快照等待订单与复盘写入桌面数据库", async () => {
  const { persistDesktopReplaySnapshot } = await import(
    "../lib/replay-persistence.mjs"
  );
  const calls = [];
  const desktopApi = {
    saveReplaySnapshot(snapshot) {
      calls.push(["snapshot", snapshot]);
      return new Promise((resolve) => {
        calls.push(["resolve", resolve]);
      });
    },
  };
  let finished = false;

  const persistence = persistDesktopReplaySnapshot(desktopApi, {
    orders: [{ orderId: "order-1" }],
    trades: [{ id: "trade-1", openPosition: { quantity: 1 } }],
  }).then(() => {
    finished = true;
  });

  await Promise.resolve();
  assert.deepEqual(calls.slice(0, 1), [["snapshot", {
    orders: [{ orderId: "order-1" }],
    trades: [{ id: "trade-1", openPosition: { quantity: 1 } }],
  }]]);
  assert.equal(finished, false);

  calls.find(([kind]) => kind === "resolve")?.[1]();
  await persistence;
  assert.equal(finished, true);
});

test("Binance、OKX 与公开带单同步都会显式等待桌面快照保存", async () => {
  const component = await readFile(
    new URL("app/components/TradeReplay.tsx", projectUrl),
    "utf8",
  );

  assert.match(component, /persistDesktopReplaySnapshot/);
  assert.match(component, /skipNextOrderAutoSaveRef/);
  assert.match(component, /skipNextTradeAutoSaveRef/);
  assert.match(component, /const handleBinanceApiSync = async/);
  assert.match(component, /const handleOkxApiSync = async/);
  assert.match(component, /const handlePublicLeadSync = useCallback\(async/);
  assert.equal(
    component.match(/await persistDesktopReplaySnapshot\(/g)?.length,
    3,
  );
  assert.equal(
    component.match(
      /\{\s*accountId:\s*result\.accountId,\s*profileId:\s*selfProfile\.id\s*\}/g,
    )?.length,
    2,
  );
});

test("桌面冷启动使用数据库中的当前仓位快照重建未平仓复盘", async () => {
  const component = await readFile(
    new URL("app/components/TradeReplay.tsx", projectUrl),
    "utf8",
  );
  const desktopTypes = await readFile(
    new URL("app/desktop-api.d.ts", projectUrl),
    "utf8",
  );

  assert.match(desktopTypes, /openPositions:\s*Array</);
  assert.match(component, /restoredOpenPositions/);
  assert.match(
    component,
    /reconstructReplayableBinanceOrders\(\s*restoredOrders,\s*\{\s*openPositions:\s*restoredOpenPositions/,
  );
});
