import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("API 更新完成前必须等待订单与复盘都写入桌面数据库", async () => {
  const { persistDesktopReplaySnapshot } = await import(
    "../lib/replay-persistence.mjs"
  );
  const resolvers = {};
  const calls = [];
  const desktopApi = {
    saveOrders(orders) {
      calls.push(["orders", orders]);
      return new Promise((resolve) => {
        resolvers.orders = resolve;
      });
    },
    saveTrades(trades) {
      calls.push(["trades", trades]);
      return new Promise((resolve) => {
        resolvers.trades = resolve;
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
  assert.deepEqual(calls.map(([kind]) => kind), ["orders", "trades"]);
  assert.equal(finished, false);

  resolvers.orders();
  await Promise.resolve();
  assert.equal(finished, false);

  resolvers.trades();
  await persistence;
  assert.equal(finished, true);
});

test("Binance、OKX 与公开带单同步都会显式等待桌面快照保存", async () => {
  const component = await readFile(
    new URL("app/components/TradeReplay.tsx", projectUrl),
    "utf8",
  );

  assert.match(component, /persistDesktopReplaySnapshot/);
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
