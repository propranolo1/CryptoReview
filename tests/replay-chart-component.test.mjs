import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as replay from "../lib/replay.mjs";
import * as indicators from "../lib/indicators.mjs";
import * as risk from "../lib/risk.mjs";
import * as history from "../lib/replay-history.mjs";
import * as markers from "../lib/replay-markers.mjs";

// 执行真实图表组件的 effects；只替换浏览器容器、React 调度和图表绘制接口。
async function chartHarness() {
  const source = await readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8");
  const component = source.slice(source.indexOf("function CandleReplayChart("), source.indexOf("export function TradeReplay()"));
  const compiled = ts.transpileModule(component, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const hooks = [];
  let hookIndex = 0;
  let effects = [];
  const timers = new Map();
  const handlers = new Map();
  const container = { clientWidth: 1000, addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: (name) => handlers.delete(name) };
  const state = { range: { from: 0, to: 2 }, fits: 0, scrolls: 0, series: [], markers: [], subscriber: null,
    timeScaleOptions: { shiftVisibleRangeOnNewBar: true }, buttons: [], animatedScrolls: 0, autoScales: 0 };
  const timeScale = {
    applyOptions: (options) => Object.assign(state.timeScaleOptions, options),
    getVisibleLogicalRange: () => state.range,
    setVisibleLogicalRange: (range) => { state.range = range; },
    subscribeVisibleLogicalRangeChange: (handler) => { state.subscriber = handler; },
    unsubscribeVisibleLogicalRangeChange: () => { state.subscriber = null; },
    fitContent: () => { state.fits += 1; },
    scrollToRealTime: () => { state.scrolls += 1; },
    scrollToPosition: (position, animated) => {
      state.scrolls += 1;
      if (animated) state.animatedScrolls += 1;
      const to = state.series[0].data.length - 1 + position;
      state.range = { from: to - (state.range.to - state.range.from), to };
    },
  };
  const chart = {
    timeScale: () => timeScale, applyOptions() {}, remove() {}, panes: () => Array.from({ length: 5 }, () => ({ setStretchFactor() {} })),
    addSeries: () => {
      const series = { data: [], priceScale: () => ({ applyOptions(options) { if (options.autoScale) state.autoScales += 1; } }), createPriceLine: () => ({}), removePriceLine() {},
        setData(data) { this.data = data; },
        update(point) {
          if (this.data.at(-1)?.time === point.time) this.data[this.data.length - 1] = point;
          else {
            // 模拟图表库在最新柱可见时默认随新柱移动视口的行为。
            if (this === state.series[0] && state.timeScaleOptions.shiftVisibleRangeOnNewBar && state.range.to >= this.data.length - 1) {
              state.range = { from: state.range.from + 1, to: state.range.to + 1 };
            }
            this.data.push(point);
          }
        },
      };
      state.series.push(series);
      return series;
    },
  };
  const library = { createChart: () => chart, createTextWatermark() {}, ColorType: { Solid: 0 }, CrosshairMode: { Normal: 0 }, LineStyle: { Dotted: 0 },
    createSeriesMarkers: () => ({ setMarkers: (value) => { state.markers = value; } }),
  };
  const dependencies = {
    ...replay, ...indicators, ...risk, ...history, ...markers,
    formatPrice: String, INDICATOR_PANE_LABELS: {},
    require: () => library,
    ResizeObserver: class { observe() {} disconnect() {} },
    React: { createElement: (type, props) => {
      if (props?.ref) props.ref.current = container;
      if (type === "button") state.buttons.push(props);
    } },
    setTimeout: (handler) => { const id = {}; timers.set(id, handler); return id; },
    clearTimeout: (id) => timers.delete(id),
    useRef: (value) => { const index = hookIndex++; return hooks[index] ??= { current: value }; },
    useState: (value) => { const index = hookIndex++; if (!(index in hooks)) hooks[index] = value; return [hooks[index], (next) => { hooks[index] = next; }]; },
    useEffect: (effect, deps) => {
      const index = hookIndex++;
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) {
        effects.push(() => { hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const renderComponent = new Function(...Object.keys(dependencies), `${compiled}; return CandleReplayChart;`)(...Object.values(dependencies));
  const render = async (props) => {
    hookIndex = 0;
    effects = [];
    state.buttons = [];
    renderComponent(props);
    effects.forEach((effect) => effect());
    await Promise.resolve();
    await Promise.resolve();
  };
  return { state, render, drag(range) { handlers.get("pointerdown")(); state.range = range; state.subscriber(); },
    wheel(range) { handlers.get("wheel")(); state.range = range; state.subscriber(); },
    followLatest() {
      const button = state.buttons.find((props) => props["aria-label"] === "恢复跟随最新 K 线");
      assert.ok(button, "手动浏览时必须可以主动恢复跟随");
      button.onClick();
    },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach((handler) => handler()); },
    dispose() { hooks.forEach((hook) => hook?.cleanup?.()); },
  };
}

test("真实组件拖到左边加载历史，前插后视口不跳、回放不穿越未来且箭头按次数合并", async () => {
  const harness = await chartHarness();
  const candle = (index) => ({ time: 1000000 + index * 300, open: 100, high: 105, low: 95, close: 102, volume: 100, closeTime: (1000000 + (index + 1) * 300) * 1000 - 1 });
  const candles = Array.from({ length: 5 }, (_, index) => candle(index));
  let loads = 0;
  let props = {
    candles, cursor: 2, entryIndex: 2, chartStartIndex: 0, candlePhase: 0.5,
    currentCandle: replay.buildPartialCandle(candles[2], 0.5), openInterest: [],
    indicatorVisibility: { ema21: true, ema200: true, volume: true }, indicatorPaneOrder: ["volume"],
    volumeColoringConfig: {}, orderFlowAvailable: false, playing: false, autoFitRequest: 0,
    onSeekToTime() {}, onLoadEarlier: () => { loads += 1; },
    trade: { id: "fixture", symbol: "BTCUSDT", side: "long", quantity: 3, entryPrice: 100, entryTime: new Date(candles[2].time * 1000).toISOString(), fee: 0, exits: [],
      entries: [0, 1, 2].map((i) => ({ quantity: 1, entryPrice: 100, entryTime: new Date(candles[2].time * 1000 + i * 10000).toISOString() })),
    },
  };
  await harness.render(props);
  await harness.render(props);
  harness.flush();
  assert.equal(loads, 0, "初始显示不能自行不断加载");
  assert.equal(harness.state.fits, 1);
  assert.equal(harness.state.markers.length, 1);
  assert.equal(harness.state.markers[0].text, "3x");
  harness.drag({ from: -10.5, to: 1.5 });
  harness.flush();
  assert.equal(loads, 1);
  await harness.render({ ...props, trade: { ...props.trade } });
  assert.equal(harness.state.fits, 1, "暂停在入场位置时其它刷新不能重置手动视口");
  const older = Array.from({ length: 40 }, (_, index) => candle(index - 40));
  props = { ...props, candles: [...older, ...candles], cursor: 42, entryIndex: 42 };
  await harness.render(props);
  assert.deepEqual(harness.state.range, { from: 29.5, to: 41.5 });
  assert.equal(harness.state.scrolls, 0);
  assert.equal(harness.state.series[0].data.length, 43);
  assert.equal(harness.state.series[0].data.at(-1).time, candles[2].time);
  assert.equal(harness.state.series[0].data.at(-1).close, props.currentCandle.close);
  assert.equal(harness.state.markers.length, 1);
  assert.equal(harness.state.markers[0].time, candles[2].time);
  props = { ...props, cursor: 43, currentCandle: replay.buildPartialCandle(candles[3], 0.5), playing: true };
  await harness.render(props);
  assert.equal(harness.state.scrolls, 0, "回放继续推进时不把正在浏览历史的视口拉回最新位置");
  harness.state.range = { from: 30, to: 44 };
  await harness.render({ ...props, cursor: 44, currentCandle: replay.buildPartialCandle(candles[4], 0.5) });
  assert.equal(harness.state.scrolls, 0, "最新柱重新可见也不能擅自恢复跟随");
  harness.followLatest();
  assert.equal(harness.state.scrolls, 1, "点击跟随最新后恢复跟随");
  harness.dispose();
  assert.equal(harness.state.subscriber, null);
});

function playbackProps() {
  const candles = Array.from({ length: 8 }, (_, index) => ({ time: 1000000 + index * 300,
    open: 100, high: 105, low: 95, close: 102, volume: 100, closeTime: (1000000 + (index + 1) * 300) * 1000 - 1 }));
  return { candles, cursor: 2, entryIndex: 2, chartStartIndex: 0, candlePhase: 0.5,
    currentCandle: replay.buildPartialCandle(candles[2], 0.5), openInterest: [],
    indicatorVisibility: { volume: true }, indicatorPaneOrder: ["volume"], volumeColoringConfig: {},
    orderFlowAvailable: false, playing: true, autoFitRequest: 0, onSeekToTime() {}, onLoadEarlier() {},
    trade: { id: "drag-fixture", symbol: "BTCUSDT", side: "long", quantity: 1, entryPrice: 100,
      entryTime: new Date(candles[2].time * 1000).toISOString(), fee: 0, exits: [] } };
}

test("播放中向任意位置拖动后，最新柱仍可见也不回弹，柱内更新与新柱均保持视口", async () => {
  const harness = await chartHarness();
  let props = playbackProps();
  await harness.render(props);
  await harness.render(props);
  const range = { from: -4.5, to: 8.5 };
  harness.drag(range);
  const autoScales = harness.state.autoScales;
  for (const [cursor, phase] of [[2, 0.8], [3, 0.1], [4, 0.5], [5, 1]]) {
    props = { ...props, cursor, candlePhase: phase, currentCandle: replay.buildPartialCandle(props.candles[cursor], phase) };
    await harness.render(props);
    assert.deepEqual(harness.state.range, range, "回放推进不能覆盖手动位置或缩放");
    assert.equal(harness.state.scrolls, 0, "不能自动滚回最新柱");
    assert.equal(harness.state.autoScales, autoScales, "不能覆盖用户手动设置的价格比例");
    assert.equal(harness.state.series[0].data.at(-1).time, props.candles[cursor].time);
  }
  await harness.render({ ...props, playing: false });
  await harness.render({ ...props, playing: true });
  assert.deepEqual(harness.state.range, range, "暂停后继续播放仍保留手动位置");
  harness.dispose();
});

test("滚轮缩放后保持位置，只有点击跟随最新才恢复跟随且不启动回弹动画", async () => {
  const harness = await chartHarness();
  let props = playbackProps();
  await harness.render(props);
  await harness.render(props);
  const range = { from: -8, to: 16 };
  harness.wheel(range);
  props = { ...props, cursor: 3, currentCandle: replay.buildPartialCandle(props.candles[3], 0.5) };
  await harness.render(props);
  assert.deepEqual(harness.state.range, range);
  harness.followLatest();
  assert.equal(harness.state.scrolls, 1);
  props = { ...props, cursor: 4, currentCandle: replay.buildPartialCandle(props.candles[4], 0.5) };
  await harness.render(props);
  assert.equal(harness.state.scrolls, 2);
  assert.equal(harness.state.range.to, 12);
  assert.equal(harness.state.range.to - harness.state.range.from, 24, "恢复跟随不改变缩放");
  assert.equal(harness.state.animatedScrolls, 0);
  harness.dispose();
});
