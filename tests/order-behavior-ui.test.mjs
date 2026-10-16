import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as domain from "../lib/order-behavior.mjs";

async function component() {
  const source = await readFile(new URL("../app/components/OrderBehaviorPanel.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function("require", "exports", code)(name => {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "react") return React;
    if (name === "@/lib/order-behavior.mjs") return domain;
    throw new Error(`非预期依赖：${name}`);
  }, exports);
  return exports.OrderBehaviorPanel;
}
const trade = { symbol: "BTCUSDT", sourceAccountId: "synthetic-account", syncSources: ["okx-api"],
  entries: [{ sourceOrderId: "1001", entryTime: "2026-10-10T01:00:00Z" }] };
const order = { userId: "synthetic-account", symbol: "BTCUSDT", orderId: "1001", sourceKind: "okx-api-normal",
  orderType: "LIMIT", side: "BUY", executedQuantity: 1, createdAt: "2026-10-10T00:00:00Z",
  fills: [{ tradeId: "1", orderId: "1001", symbol: "BTCUSDT", time: "2026-10-10T01:00:00Z", quantity: 1 }] };

test("真实分析组件显示客观等待、来源、证据与可调阈值，支持缺失数据", async () => {
  const Component = await component();
  const html = renderToStaticMarkup(React.createElement(Component, { trade, orders: [order] }));
  for (const text of ["入场挂单分析", "OKX", "1001", "1小时", "久挂后成交", "追价情况未知", "快速成交阈值", "久挂阈值"]) {
    assert.ok(html.includes(text), text);
  }
  const missing = renderToStaticMarkup(React.createElement(Component, { trade, orders: [] }));
  assert.ok(missing.includes("无法判断")); assert.ok(!missing.includes("等待 0秒"));
});

test("非 API 复盘不显示分析，回放到入场之前不暴露未来结论", async () => {
  const Component = await component();
  assert.equal(renderToStaticMarkup(React.createElement(Component, { trade: { ...trade, syncSources: ["smart-money-public"] }, orders: [order] })), "");
  const html = renderToStaticMarkup(React.createElement(Component, { trade, orders: [order], asOfTime: Date.parse("2026-10-10T00:30:00Z") }));
  assert.ok(!html.includes("久挂后成交")); assert.ok(html.includes("回放到入场"));
});

test("复盘界面向分析组件传递当前用户档案与回放时间", async () => {
  const source = await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8");
  assert.match(source, /<OrderBehaviorPanel\s+key=\{activeProfile\.id\}\s+trade=\{trade\}\s+orders=\{activeProfileOrders\}\s+asOfTime=\{currentReplayTimeMs[^}]*\}/);
});
