import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as preview from "../lib/trade-preview.mjs";

// 执行实际组件；替换 React 调度、DOM 和网络，验证事件委托与 Portal 生命周期。
async function uiHarness() {
  const source = await readFile(new URL("../app/components/TradeHoverPreview.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const hooks = [], timers = new Map(), handlers = new Map(), requests = [];
  let index = 0, effects = [], tree;
  const current = Date.parse("2026-09-22T00:00:00Z"), start = current - 2 * 86400_000;
  const trades = [{ id: "one", symbol: "BTCUSDT", side: "short", quantity: 1, entryPrice: 100,
    entryTime: new Date(start).toISOString(), fee: 0,
    exits: [{ exitTime: new Date(start + 60_000).toISOString(), exitPrice: 99, quantity: 1, fee: 0 }] }];
  class FakeElement {
    dataset = { previewTradeId: "one" };
    closest() { return this; }
    getBoundingClientRect() { return { left: 20, right: 300, top: 100 }; }
  }
  const react = {
    useRef(value) { const slot = index++; return hooks[slot] ??= { current: value }; },
    useState(value) { const slot = index++; if (!(slot in hooks)) hooks[slot] = value;
      return [hooks[slot], (next) => { hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next; }]; },
    useMemo(fn) { index++; return fn(); },
    useEffect(fn, deps) { const slot = index++;
      if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot].deps[i])) {
        effects.push(() => { hooks[slot]?.cleanup?.(); hooks[slot] = { deps, cleanup: fn() }; });
      }
    },
  };
  const jsx = (type, props) => {
    if (props.ref) props.ref.current = { closest: (selector) => selector === ".replay-app" ? "theme-root" : null };
    return { type, props };
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const query = new URL(url, "http://localhost").searchParams;
    const from = Number(query.get("startTime")), to = Number(query.get("endTime"));
    return { ok: true, json: async () => ({ symbol: "BTCUSDT", interval: query.get("interval"),
      candles: Array.from({ length: Math.ceil((to - from) / 60_000) + 1 }, (_, i) => ({ time: (from + i * 60_000) / 1000,
        close: 100 - i * 0.1, closeTime: from + (i + 1) * 60_000 - 1 })) }) };
  };
  const require = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "react-dom") return { createPortal: (child, target) => ({ type: "portal", child, target }) };
    if (name.endsWith(".css")) return new Proxy({}, { get: (_, name) => String(name) });
    return { ...preview, createTradePreviewController: (options) => preview.createTradePreviewController({ ...options,
      now: () => current, setTimer: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; }, clearTimer: (id) => timers.delete(id) }) };
  };
  const window = { innerWidth: 1600, innerHeight: 900, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name) };
  const exports = {};
  new Function("exports", "require", "fetch", "window", "document", "Element", compiled)(exports, require, fetch, window, { body: "body" }, FakeElement);
  const render = (values = trades) => { index = 0; effects = []; tree = exports.TradeHoverPreview({ trades: values, children: "rows" }); effects.forEach((fn) => fn()); return tree; };
  const root = () => tree.props.children[0];
  const portal = () => tree.props.children[1];
  const flush = async (delay) => { const pending = [...timers].filter(([, value]) => value.delay === delay); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, value]) => value.fn());
    for (let i = 0; i < 12; i++) await Promise.resolve(); render(); };
  render();
  return { render, root, portal, flush, requests, handlers, row: new FakeElement(), trades,
    dispose() { hooks.forEach((hook) => hook?.cleanup?.()); } };
}

test("真实列表组件鼠标悬停与键盘聚焦都打开 Portal，进入小图保持，点击或 Esc 关闭", async () => {
  const h = await uiHarness();
  h.root().props.onPointerOver({ target: h.row, pointerType: "mouse" });
  await h.flush(300);
  assert.equal(h.requests.length, 1);
  assert.equal(h.portal().target, "theme-root", "Portal 必须继承应用的日夜主题");
  assert.equal(h.portal().child.props.role, "tooltip");
  assert.equal(h.portal().child.props.style.left, 308);
  assert.match(JSON.stringify(h.portal()), /S 卖出.*B 买入/);
  h.root().props.onPointerLeave(); h.portal().child.props.onPointerEnter(); await h.flush(150);
  assert.ok(h.portal());
  h.root().props.onClick(); h.render(); assert.equal(h.portal(), null);
  h.root().props.onFocus({ target: h.row }); await h.flush(300);
  assert.ok(h.portal()); assert.equal(h.requests.length, 1);
  h.portal().child.props.onKeyDown({ key: "Escape" }); h.render(); assert.equal(h.portal(), null);
  h.dispose();
});

test("滚动、窗口变化、筛选交易变化和右键操作清除预览，触屏不触发鼠标悬停", async () => {
  const h = await uiHarness();
  h.root().props.onPointerOver({ target: h.row, pointerType: "touch" }); await h.flush(300);
  assert.equal(h.requests.length, 0);
  const open = async () => { h.root().props.onFocus({ target: h.row }); await h.flush(300); assert.ok(h.portal()); };
  await open(); h.root().props.onScroll(); h.render(); assert.equal(h.portal(), null);
  await open(); h.handlers.get("resize")(); h.render(); assert.equal(h.portal(), null);
  await open(); h.root().props.onContextMenu(); h.render(); assert.equal(h.portal(), null);
  await open(); h.render([]); h.render([]); assert.equal(h.portal(), null);
  h.dispose(); assert.equal(h.handlers.size, 0);
});

test("交易列表使用当前用户的筛选记录，弹窗保持固定尺寸并使用日夜主题变量", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TradeHoverPreview.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<TradeHoverPreview key=\{activeProfile\.id\} trades=\{filteredTrades\}>/);
  assert.match(source, /data-preview-trade-id=\{item\.id\}/);
  assert.match(css, /width: 380px/); assert.match(css, /height: 220px/);
  assert.match(css, /var\(--text\)/); assert.match(css, /var\(--menu-bg/);
});
