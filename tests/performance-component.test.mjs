import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as performance from "../lib/performance.mjs";

// 执行真实组件和交互回调，仅替换 React 调度与 CSS 模块。
async function componentHarness(name) {
  const source = await readFile(new URL(`../app/components/${name}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const states = [];
  let cursor = 0;
  const react = {
    useId: () => `test-${cursor++}`,
    useMemo: (fn) => fn(),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
  };
  const exports = {};
  const require = (id) => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id.endsWith(".css")) return { default: new Proxy({}, { get: (_, key) => key }) };
    if (id === "@/lib/performance.mjs") return performance;
    if (id === "./PerformanceDistributionCharts") return { PerformanceDistributionCharts: () => null };
    throw new Error(`未替换的依赖：${id}`);
  };
  new Function("require", "exports", compiled)(require, exports);
  return (props) => {
    cursor = 0;
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      nodes.push(node);
      visit(node.props?.children);
    }
    visit(exports[name](props));
    return nodes;
  };
}

const holding = { averageWinHoldingMs: null, averageLossHoldingMs: null, winHoldingSamples: 0, lossHoldingSamples: 0 };

test("真实分布组件切换 15/30/60 档保持笔数，键盘聚焦显示精确区间和占比", async () => {
  const render = await componentHarness("PerformanceDistributionCharts");
  const props = { ...holding, bins: performance.buildProfitPercentDistribution(Array.from({ length: 49 }, (_, index) => (index - 24) / 10)) };
  let nodes = render(props);
  for (const count of [30, 60, 15]) {
    nodes.find((node) => node.type === "button" && node.props.children[0] === count).props.onClick();
    nodes = render(props);
    const bins = nodes.filter((node) => node.type === "g" && node.props.tabIndex === 0);
    assert.equal(bins.length, count);
    assert.equal(bins.reduce((sum, node) => sum + Number(node.props["aria-label"].match(/，(\d+) 笔/)[1]), 0), 49);
    bins[0].props.onFocus();
    const tooltip = render(props).find((node) => node.props.role === "tooltip");
    assert.match(JSON.stringify(tooltip), /占/);
    assert.match(JSON.stringify(tooltip), /−2\.40+%/);
    bins[0].props.onBlur();
    assert.equal(render(props).some((node) => node.props.role === "tooltip"), false);
  }
});

test("分布组件对空样本、相同收益和细小收益不产生无效坐标或重复端点标签", async () => {
  const render = await componentHarness("PerformanceDistributionCharts");
  for (const values of [[], [0, 0], [0.00001, 0.00002]]) {
    const nodes = render({ ...holding, bins: performance.buildProfitPercentDistribution(values) });
    assert.doesNotMatch(JSON.stringify(nodes), /NaN|Infinity/);
    const ticks = nodes.filter((node) => node.type === "text" && node.props.y === 216);
    assert.equal(new Set(ticks.map((node) => node.props.children)).size, ticks.length);
  }
});

function trade(index, pnl, feesKnown = true) {
  return { id: `fixture-${index}`, side: "long", quantity: 1, entryPrice: 100,
    entryTime: "2026-07-01T00:00:00Z", fee: 1, feesKnown,
    exits: [{ quantity: 1, exitPrice: 102 + pnl, fee: 1, exitTime: `2026-0${index % 2 === 0 ? 7 : 8}-16T00:00:00Z` }] };
}

test("统计图保留平手比例、未知费用覆盖率和零盈亏，日历仍可切换月份", async () => {
  const render = await componentHarness("PerformanceOverview");
  const props = { trades: [trade(0, 10), trade(1, -10, false), trade(2, 0)], selectedDate: null };
  let nodes = render(props);
  assert.ok(nodes.some((node) => node.props["aria-label"] === "胜负占比：1 胜、1 负、1 平"));
  assert.ok(nodes.some((node) => node.props["aria-label"] === "手续费数据覆盖率 66.7%"));
  assert.ok(nodes.some((node) => node.props["aria-label"] === "总盈亏累计趋势，从零起点开始"));
  assert.ok(nodes.some((node) => node.props["aria-label"] === "2026年8月"));
  nodes.find((node) => node.props["aria-label"] === "上一个月").props.onClick();
  nodes = render(props);
  assert.ok(nodes.some((node) => node.props["aria-label"] === "2026年7月"));
  for (const trades of [[trade(0, 0)], [trade(0, 10)], [trade(0, -10)], []]) {
    assert.doesNotMatch(JSON.stringify(render({ ...props, trades })), /NaN|Infinity/);
  }
});
