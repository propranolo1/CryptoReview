import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function harness() {
  const source = await readFile(new URL("../app/components/AssetAvatar.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const hooks = [], effects = [], observers = [], requests = [], failures = [];
  let index = 0, symbol = "BTCUSDT", tree;
  const react = {
    useRef(value) { const slot = index++; return hooks[slot] ??= { current: value }; },
    useState(value) { const slot = index++; if (!(slot in hooks)) hooks[slot] = value;
      return [hooks[slot], (next) => { hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next; }]; },
    useEffect(fn, deps) { const slot = index++;
      if (!hooks[slot] || deps.some((value, i) => value !== hooks[slot].deps[i])) {
        effects.push(() => { hooks[slot]?.cleanup?.(); hooks[slot] = { deps, cleanup: fn() }; });
      }
    },
  };
  const jsx = (type, props) => { if (props.ref) props.ref.current = {}; return { type, props }; };
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  }
  const loader = {
    load(value) { return new Promise((resolve) => requests.push({ symbol: value, resolve })); },
    reportFailure(value, src) { failures.push({ symbol: value, src }); },
  };
  const require = (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : { createAssetIconLoader: () => loader };
  const exports = {};
  new Function("exports", "require", "IntersectionObserver", compiled)(exports, require, Observer);
  const render = (value = symbol) => { symbol = value; index = 0; effects.length = 0;
    tree = exports.AssetAvatar({ symbol }); effects.forEach((fn) => fn()); return tree; };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); render(); };
  render();
  return { render, flush, observers, requests, failures, root: () => tree,
    img: () => tree.props.children[1], dispose: () => hooks.forEach((value) => value?.cleanup?.()) };
}

test("真实图标组件先显示字母，仅可见时加载，图片完成解码后原位替换", async () => {
  const h = await harness();
  assert.equal(h.root().props.children[0], "B"); assert.equal(h.requests.length, 0);
  h.observers[0].fn([{ isIntersecting: false }]); assert.equal(h.requests.length, 0);
  h.observers[0].fn([{ isIntersecting: true }]);
  h.observers[0].fn([{ isIntersecting: true }]); assert.equal(h.requests.length, 1);
  h.requests[0].resolve("data:image/png;base64,test"); await h.flush();
  assert.equal(h.root().props.children[0], "B");
  assert.equal(h.img().props.className, "asset-avatar-image-loading");
  h.img().props.onLoad(); h.render();
  assert.equal(h.root().props.children[0], false);
  assert.match(h.root().props.className, /has-image/);
  assert.equal(h.img().props.width, 25); assert.equal(h.img().props.height, 25);
  h.dispose();
});

test("解码失败回退字母，换币种或卸载后迟到请求不会覆盖新图标", async () => {
  const h = await harness();
  h.observers[0].fn([{ isIntersecting: true }]);
  h.render("ETHUSDT"); h.observers[1].fn([{ isIntersecting: true }]);
  h.requests[0].resolve("old-btc"); await h.flush();
  assert.equal(h.root().props.children[0], "E"); assert.equal(h.img(), null);
  h.requests[1].resolve("eth-icon"); await h.flush();
  const oldEvents = h.img().props;
  oldEvents.onError(); h.render();
  assert.equal(h.root().props.children[0], "E"); assert.equal(h.img(), null);
  assert.deepEqual(h.failures, [{ symbol: "ETHUSDT", src: "eth-icon" }]);
  h.render("SOLUSDT"); oldEvents.onLoad(); h.render(); assert.equal(h.img(), null);
  h.observers[2].fn([{ isIntersecting: true }]); h.dispose();
  h.requests[2].resolve("sol-icon"); await h.flush(); assert.equal(h.img(), null);
});

test("仅左侧交易行接入图标，尺寸固定且图标不干扰列表事件", async () => {
  const [replay, css, route] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/assets/icon/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(replay, /<AssetAvatar symbol=\{item\.symbol\} \/>/);
  assert.match(replay, /data-preview-trade-id=\{item\.id\}/);
  assert.match(replay, /onContextMenu=\{\(event\) => openTradeContextMenu\(event, item\)\}/);
  assert.match(css, /flex: 0 0 25px/); assert.match(css, /object-fit: contain/);
  assert.match(route, /assetIconResponse\(request, service\)/);
});
