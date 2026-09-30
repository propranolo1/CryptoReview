import assert from "node:assert/strict";
import test from "node:test";
import { createReplayMarkerRings, drawReplayMarkerRing } from "../lib/replay-marker-rings.mjs";

function canvas() {
  const arcs = [], labels = [];
  return { arcs, labels, save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    arc(...values) { arcs.push(values); }, fillText(...values) { labels.push(values); } };
}

test("圆环从十二点方向绘制真实占比，超过满仓仍显示真实百分比", () => {
  for (const [ratio, label, angle] of [[0.25, "25%", Math.PI / 2], [1, "100%", Math.PI * 2], [1.5, "150%", Math.PI * 2]]) {
    const context = canvas();
    drawReplayMarkerRing(context, 100, 200, ratio, "green");
    assert.deepEqual(context.labels[0], [label, 100, 200]);
    assert.equal(context.arcs[2][3], -Math.PI / 2);
    assert.equal(context.arcs[2][4] - context.arcs[2][3], angle);
  }
  const context = canvas();
  drawReplayMarkerRing(context, 0, 0, Number.NaN, "green");
  assert.deepEqual(context.arcs, []);
});

test("原生圆环按当前时间和价格坐标绘制，拖动缩放重新定位且离屏成交不绘制", () => {
  const primitive = createReplayMarkerRings();
  let x = 100, priceY = 150, updates = 0;
  primitive.attached({ chart: { timeScale: () => ({ timeToCoordinate: () => x }) },
    series: { priceToCoordinate: () => priceY }, requestUpdate: () => { updates += 1; } });
  primitive.setMarkers([{ time: 1000, side: "buy", anchorPrice: 10, ratio: 0.5 }]);
  const render = () => {
    const context = canvas();
    primitive.paneViews()[0].renderer().draw({ useMediaCoordinateSpace: (draw) => draw({ context, mediaSize: { width: 300, height: 400 } }) });
    return context;
  };
  assert.equal(updates, 1);
  assert.deepEqual(render().labels[0], ["50%", 100, 196]);
  x = 200; priceY = 220;
  assert.deepEqual(render().labels[0], ["50%", 200, 266]);
  x = 400;
  assert.deepEqual(render().labels, []);
  primitive.detached();
  assert.deepEqual(render().labels, []);
});
