/** 页面和导出视频共用的成交占比圆环。超过满仓的同柱往返显示真实百分比，环填满。 */
export function drawReplayMarkerRing(context, x, y, ratio, color, radius = 16) {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  context.save();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(x, y, radius + 2, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#e5e7eb";
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = color;
  context.beginPath();
  context.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.min(1, ratio) * Math.PI * 2);
  context.stroke();
  const percent = ratio * 100;
  const label = `${Number(percent.toPrecision(percent < 1 ? 2 : 3))}%`;
  context.font = `700 ${label.length > 5 ? 8 : 9}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = color;
  context.fillText(label, x, y);
  context.restore();
}

/** 交给图表原生绘制周期定位，缩放、拖动、价格比例及高清屏变化时自动重绘。 */
export function createReplayMarkerRings() {
  let attachment = null;
  let markers = [];
  const view = {
    zOrder: () => "top",
    renderer: () => ({
      draw(target) {
        if (!attachment) return;
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          for (const marker of markers) {
            if (marker.ratio === null) continue;
            const x = attachment.chart.timeScale().timeToCoordinate(marker.time);
            const priceY = attachment.series.priceToCoordinate(marker.anchorPrice);
            if (x === null || priceY === null || x < -18 || x > mediaSize.width + 18) continue;
            const y = priceY + (marker.side === "buy" ? 46 : -46);
            drawReplayMarkerRing(context, x, y, marker.ratio, marker.side === "buy" ? "#30c487" : "#ef6572");
          }
        });
      },
    }),
  };
  return {
    attached(value) { attachment = value; },
    detached() { attachment = null; markers = []; },
    paneViews: () => [view],
    autoscaleInfo() {
      return markers.some((marker) => marker.ratio !== null)
        ? { priceRange: null, margins: { above: 66, below: 66 } }
        : null;
    },
    setMarkers(value) { markers = value; attachment?.requestUpdate(); },
  };
}
