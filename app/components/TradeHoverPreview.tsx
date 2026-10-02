"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { createTradePreviewController, type PreviewController, type PreviewMarker, type PreviewState, type PreviewTrade } from "@/lib/trade-preview.mjs";
import styles from "./TradeHoverPreview.module.css";

const timeLabel = (time: number) => new Date(time).toLocaleString("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const numberLabel = (value: number) => value.toLocaleString("zh-CN", { maximumSignificantDigits: 7 });
const holdingLabel = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))} 秒`
  : ms < 3600_000 ? `${Math.floor(ms / 60_000)} 分钟`
  : ms < 86400_000 ? `${(ms / 3600_000).toFixed(1)} 小时` : `${(ms / 86400_000).toFixed(1)} 天`;
const markerLabel = (marker: PreviewMarker) => marker.events.map((event) =>
  `${event.side === "buy" ? "B 买入" : "S 卖出"} · ${timeLabel(event.timeMs)} · 价格 ${numberLabel(event.price)} · 数量 ${numberLabel(event.quantity)}`,
).join("\n");

/** 保留原交易列表结构，预览通过 Portal 避开侧栏的滚动裁切。 */
export function TradeHoverPreview({ trades, children }: { trades: PreviewTrade[]; children: ReactNode }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [activeMarker, setActiveMarker] = useState<PreviewMarker | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const controller = useRef<PreviewController | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const byId = useMemo(() => new Map(trades.map((trade) => [trade.id, trade])), [trades]);

  useEffect(() => {
    const current = createTradePreviewController({ fetchImpl: fetch, onChange: (value) => {
      if (value) setPortalRoot(list.current?.closest<HTMLElement>(".replay-app") ?? document.body);
      setActiveMarker(null);
      setPreview(value);
    } });
    controller.current = current;
    const close = () => current.close();
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("resize", close); current.dispose(); controller.current = null; };
  }, []);
  useEffect(() => { controller.current?.close(); }, [trades]);

  const enter = (event: SyntheticEvent) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-preview-trade-id]") : null;
    const trade = row ? byId.get(row.dataset.previewTradeId ?? "") : null;
    if (!row || !trade) { controller.current?.leave(); return; }
    controller.current?.enter(trade, row.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  };
  const plot = preview?.plot, plan = preview?.plan;

  return <>
    <div ref={list} className="trade-list" role="list" aria-label="交易列表"
      onPointerOver={(event) => { if (event.pointerType !== "touch") enter(event); }}
      onPointerLeave={() => controller.current?.leave()} onFocus={enter} onBlur={() => controller.current?.leave()}
      onScroll={() => controller.current?.close()} onClick={() => controller.current?.close()}
      onContextMenu={() => controller.current?.close()} onKeyDown={(event) => { if (event.key === "Escape") controller.current?.close(); }}>
      {children}
    </div>
    {preview && portalRoot && createPortal(
      <aside className={styles.preview} role="tooltip" aria-label={`${preview.trade.symbol} 整笔交易行情预览`}
        style={{ left: preview.position.left, top: preview.position.top }}
        onPointerEnter={() => controller.current?.retain()} onPointerLeave={() => controller.current?.leave()}
        onFocus={() => controller.current?.retain()} onBlur={() => controller.current?.leave()}
        onKeyDown={(event) => { if (event.key === "Escape") controller.current?.close(); }}>
        <div className={styles.heading}>
          <strong>{preview.trade.symbol} <span className={preview.trade.side === "long" ? styles.buy : styles.sell}>{preview.trade.side === "long" ? "多" : "空"}</span></strong>
          <span>{plan?.open ? "未平仓 · " : ""}{plan ? `持仓 ${holdingLabel(plan.holdingMs)}` : "交易概览"}</span>
        </div>
        {preview.status === "ready" && plot && plan ? <>
          <div className={styles.chart}>
            <svg viewBox="0 0 356 154" width="356" height="154" aria-label="价格折线及 B/S 成交点">
              <rect x={plot.entryX} y="8" width={Math.max(0, plot.endX - plot.entryX)} height="126" className={styles.holdingArea} />
              {[16, 70, 124].map((y, index) => <g key={y}>
                <line x1="8" x2="302" y1={y} y2={y} className={styles.grid} />
                <text x="309" y={y + 3} className={styles.axis}>{numberLabel(plot.maximum - index * (plot.maximum - plot.minimum) / 2)}</text>
              </g>)}
              <path d={plot.path} className={styles.line} />
              {plot.markers.map((marker, index) => <g key={index} className={marker.side === "buy" ? styles.buy : styles.sell}
                role="img" tabIndex={0} aria-label={markerLabel(marker)}
                onPointerEnter={() => setActiveMarker(marker)} onPointerLeave={() => setActiveMarker(null)}
                onFocus={() => setActiveMarker(marker)} onBlur={() => setActiveMarker(null)}>
                <title>{markerLabel(marker)}</title>
                <circle cx={marker.x} cy={marker.y} r="9" fill="transparent" />
                <circle cx={marker.x} cy={marker.y} r="3" className={styles.dot} />
                <text x={marker.x} y={marker.labelY} textAnchor="middle" className={styles.marker}>{marker.side === "buy" ? "B" : "S"}{marker.events.length > 1 ? `×${marker.events.length}` : ""}</text>
              </g>)}
              <text x="8" y="149" className={styles.axis}>{timeLabel(plan.startTime)}</text>
              <text x="302" y="149" textAnchor="end" className={styles.axis}>{timeLabel(plan.endTime)}</text>
            </svg>
            {activeMarker && <div className={styles.markerTooltip}>{markerLabel(activeMarker)}</div>}
          </div>
          <div className={styles.footer}>
            <span title={preview.source}>{preview.source} · {plan.interval}</span>
            <span title={plot.notice || "阴影为持仓期间；B 买入，S 卖出"}>{plot.notice || "B 买入 · S 卖出"}</span>
          </div>
        </> : <div className={styles.message} role="status">{preview.message}</div>}
      </aside>, portalRoot,
    )}
  </>;
}
