import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { buildTradeListRows, summarizeTradeListByToken } from "../lib/trade-list.mjs";
import { filterTradesByToken } from "../lib/trade-index.mjs";
import { getTradeCloseTime } from "../lib/performance.mjs";

const jsx = (type, props) => ({ type, props });
function flatten(tree) {
  const nodes = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    nodes.push(node); visit(node.props?.children);
  }
  visit(tree); return nodes;
}
const rows = nodes => nodes.filter(node => node.props["data-preview-trade-id"]);

// 执行真实侧栏 JSX，按正式纯函数生成筛选、金额和顺序。
async function sidebarHarness() {
  const source = await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8");
  const begin = source.indexOf("          <TradeListControls key={activeProfile.id}");
  const end = source.indexOf("</TradeHoverPreview>", begin) + "</TradeHoverPreview>".length;
  assert.ok(begin > 0 && end > begin);
  const compiled = ts.transpileModule(`export function Sidebar(p: any) { const {
    selectedTradeIndex, STARRED_TRADE_FILTER, tokenGroups, starredTrades, selectTradeIndex,
    tradeSortBy, tradeSortDirection, setTradeSortBy, setTradeSortDirection, filteredTrades,
    tradeListRows, tradeListTotal, activeProfile, trade, deletingTradeId, selectTrade, openTradeContextMenu,
    getReplaySourceDisplay, displaySymbol, formatMoney, formatDateTime, getTradeCloseTime,
    TradeListControls, TradeHoverPreview, AssetAvatar, Star, ChevronRight
  } = p; return <>${source.slice(begin, end)}</>; }`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(() => ({ jsx, jsxs: jsx, Fragment: "fragment" }), exports);
  let selectedToken = null, sortBy = "date", direction = "desc", selectedId = "small";
  const now = Date.parse("2026-10-01T12:00:00Z");
  const items = [["small", 1, 1, "BTCUSDT"], ["loss", -50, 3, "BTCUSDT"],
    ["large", 100, 2, "BTCUSDC"], ["eth", 500, 1, "ETHUSDT"]].map(([id, pnl, hours, symbol]) => ({
    id, symbol, side: "long", quantity: 1, entryPrice: 1000, starred: id === "large",
    entryTime: new Date(now - hours * 3_600_000).toISOString(),
    exits: [{ quantity: 1, exitPrice: 1000 + pnl, exitTime: new Date(now).toISOString() }],
  }));
  const render = (allTrades = items) => {
    const starredTrades = allTrades.filter(item => item.starred);
    const filteredTrades = selectedToken === "starred" ? starredTrades : filterTradesByToken(allTrades, selectedToken);
    const tradeListRows = buildTradeListRows(filteredTrades, { sortBy, direction, now });
    const tradeListTotal = tradeListRows.some(row => !row.pnl) ? null : tradeListRows.reduce((sum, row) => sum + row.pnl.totalPnl, 0);
    return flatten(exports.Sidebar({ selectedTradeIndex: selectedToken, STARRED_TRADE_FILTER: "starred",
      tokenGroups: summarizeTradeListByToken(allTrades), starredTrades, filteredTrades, tradeListRows, tradeListTotal,
      tradeSortBy: sortBy, tradeSortDirection: direction, activeProfile: { id: "a" },
      trade: items.find(item => item.id === selectedId), deletingTradeId: null,
      selectTradeIndex: value => { selectedToken = value; }, setTradeSortBy: value => { sortBy = value; },
      setTradeSortDirection: fn => { direction = fn(direction); }, selectTrade: id => { selectedId = id; },
      openTradeContextMenu: () => {}, getReplaySourceDisplay: () => ({ title: "合成测试", shortLabel: "测试" }),
      displaySymbol: value => value, formatMoney: value => String(value), formatDateTime: value => String(value),
      getTradeCloseTime, TradeListControls: "controls", TradeHoverPreview: "preview", AssetAvatar: "avatar", Star: "star", ChevronRight: "chevron" }));
  };
  return { render, source, get selectedId() { return selectedId; } };
}

test("代币与日期/持有时间/带正负号金额排序独立组合，升降序不改变主图选择", async () => {
  const ui = await sidebarHarness();
  const controls = () => ui.render().find(node => node.type === "controls").props;
  controls().onTokenChange("BTC"); controls().onSortChange("holding");
  assert.deepEqual(rows(ui.render()).map(row => row.props["data-preview-trade-id"]), ["loss", "large", "small"]);
  controls().onDirectionChange();
  assert.deepEqual(rows(ui.render()).map(row => row.props["data-preview-trade-id"]), ["small", "large", "loss"]);
  controls().onSortChange("pnl");
  assert.deepEqual(rows(ui.render()).map(row => row.props["data-preview-trade-id"]), ["loss", "small", "large"]);
  assert.equal(controls().selectedToken, "BTC"); assert.equal(controls().formattedTotal, "51");
  controls().onDirectionChange();
  assert.deepEqual(rows(ui.render()).map(row => row.props["data-preview-trade-id"]), ["large", "small", "loss"]);
  assert.equal(ui.selectedId, "small"); controls().onTokenChange("ETH");
  assert.equal(controls().sortBy, "pnl"); assert.equal(controls().direction, "desc");
  assert.equal(controls().formattedTotal, "500");
  assert.deepEqual(rows(ui.render()).map(row => row.props["data-preview-trade-id"]), ["eth"]);
  controls().onSortChange("date"); assert.equal(controls().selectedToken, "ETH");
});

test("真实交易行保留金额渐变和选中标记，移除持有时长文字", async () => {
  const ui = await sidebarHarness(); const nodes = ui.render(); const [small, loss, large] = rows(nodes);
  assert.match(small.props.style["--trade-tint"], /var\(--profit\)/);
  assert.match(loss.props.style["--trade-tint"], /var\(--loss\)/);
  const percent = node => Number(node.props.style["--trade-tint"].match(/([\d.]+)%/)[1]);
  assert.ok(percent(large) > percent(small)); assert.match(small.props.className, /active/);
  assert.ok(!nodes.some(node => node.props.className === "trade-list-duration"));
  assert.doesNotMatch(ui.source, /formatTradeHoldingTime|trade-index-mode|trade-sort-controls/);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.trade-list-item\s*\{[^}]*background:\s*var\(--trade-tint/s);
  assert.match(css, /\.trade-list-item.active\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--amber\)/s);
});

test("星标和空态保留在新筛选流程，金额汇总随范围变化", async () => {
  const ui = await sidebarHarness(); ui.render().find(node => node.type === "controls").props.onStarredChange(true);
  assert.deepEqual(rows(ui.render()).map(row => row.props["data-preview-trade-id"]), ["large"]);
  assert.equal(ui.render().find(node => node.type === "controls").props.formattedTotal, "100");
  const empty = ui.render([]); assert.equal(rows(empty).length, 0);
  assert.ok(empty.some(node => node.props.className === "date-filter-empty"));
});

// 轻量调度替身执行真实选择框及页面外部点击/键盘事件。
async function controlsHarness() {
  const source = await readFile(new URL("../app/components/TradeListControls.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const hooks = [], effects = [], listeners = new Map(); let index = 0, focused = false;
  const react = {
    useId: () => "picker",
    useRef(value) { const slot = index++; return hooks[slot] ??= { current: value }; },
    useState(value) { const slot = index++; if (!(slot in hooks)) hooks[slot] = value;
      return [hooks[slot], next => { hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next; }]; },
    useEffect(fn, deps) { const slot = index++;
      if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot].deps[i])) effects.push(() => {
        hooks[slot]?.cleanup?.(); hooks[slot] = { deps, cleanup: fn() };
      }); },
  };
  const renderJsx = (type, props) => {
    if (props.ref) props.ref.current = { contains: target => target === "inside", focus: () => { focused = true; } };
    return { type, props };
  };
  const exports = {};
  new Function("require", "exports", "document", compiled)(name => name === "react" ? react
    : name === "react/jsx-runtime" ? { jsx: renderJsx, jsxs: renderJsx } : { ChevronDown: "chevron" }, exports,
    { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) });
  const props = { tokens: [{ token: "BTC", count: 3 }, { token: "ETH", count: 1 }], selectedToken: null,
    starredOnly: false, starredCount: 1, sortBy: "date", direction: "desc", tradeCount: 4,
    totalPnl: 51, formattedTotal: "+$51.00", hasOpenPositions: false,
    onTokenChange: token => { props.selectedToken = token; props.starredOnly = false; },
    onStarredChange: enabled => { props.starredOnly = enabled; props.selectedToken = null; },
    onSortChange: sort => { props.sortBy = sort; },
    onDirectionChange: () => { props.direction = props.direction === "desc" ? "asc" : "desc"; } };
  const render = () => { index = 0; const nodes = flatten(exports.TradeListControls(props)); while (effects.length) effects.shift()(); return nodes; };
  const find = label => render().find(node => node.props["aria-label"] === label);
  render(); return { render, find, props, listeners, get focused() { return focused; }, dispose: () => hooks.forEach(hook => hook?.cleanup?.()) };
}

test("单一选择框同时设置实际交易代币和三个排序依据，升降序为框外独立按钮", async () => {
  const ui = await controlsHarness();
  assert.equal(ui.render().filter(node => node.props["aria-haspopup"] === "dialog").length, 1);
  ui.find("交易筛选与排序：全部代币 · 按日期").props.onClick();
  ui.find("BTC").props.onChange(); ui.find("按盈亏金额").props.onChange();
  assert.equal(ui.props.selectedToken, "BTC"); assert.equal(ui.find("BTC").props.checked, true);
  assert.equal(ui.find("按盈亏金额").props.checked, true); assert.equal(ui.find("切换为升序").type, "button");
  ui.find("切换为升序").props.onClick(); assert.equal(ui.props.direction, "asc");
  ui.find("ETH").props.onChange(); assert.equal(ui.props.sortBy, "pnl");
  ui.find("按持有时间").props.onChange(); assert.equal(ui.props.selectedToken, "ETH");
  assert.ok(!ui.render().some(node => node.props["aria-label"] === "SOL"));
  ui.render().find(node => node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  assert.equal(ui.props.starredOnly, true); ui.dispose();
});

test("选择框点击外部或 Escape 关闭，内部选择保持展开，汇总区分未知和浮动盈亏", async () => {
  const ui = await controlsHarness(); const toggle = () => ui.render().find(node => node.props["aria-haspopup"] === "dialog");
  toggle().props.onClick(); ui.render(); ui.listeners.get("pointerdown")({ target: "inside" });
  assert.equal(toggle().props["aria-expanded"], true); ui.listeners.get("pointerdown")({ target: "outside" });
  assert.equal(toggle().props["aria-expanded"], false); toggle().props.onClick(); ui.render();
  ui.listeners.get("keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(toggle().props["aria-expanded"], false); assert.equal(ui.focused, true);
  ui.props.totalPnl = null; ui.props.formattedTotal = "—";
  assert.ok(ui.render().some(node => node.props.title === "部分记录盈亏未知，无法计算总额"));
  ui.props.totalPnl = -5; ui.props.formattedTotal = "−$5.00"; ui.props.hasOpenPositions = true;
  assert.ok(ui.render().some(node => node.props.className === "negative" && node.props.children === "−$5.00"));
  assert.ok(ui.render().some(node => node.props.title?.includes("最新同步价格"))); ui.dispose();
});
