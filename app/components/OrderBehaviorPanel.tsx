"use client";

import { useMemo, useState } from "react";
import { getTradeEntryOrderBehaviors, type OrderBehaviorTrade } from "@/lib/order-behavior.mjs";
import type { BinanceUsdmOrder } from "@/lib/binance-orders.mjs";

export function OrderBehaviorPanel({ trade, orders, asOfTime }: {
  trade: OrderBehaviorTrade;
  orders: BinanceUsdmOrder[];
  asOfTime?: number;
}) {
  const [rapidSeconds, setRapidSeconds] = useState(60);
  const [longMinutes, setLongMinutes] = useState(30);
  const allRows = useMemo(() => getTradeEntryOrderBehaviors(trade, orders, {
    rapidFillMs: rapidSeconds * 1000, longWaitMs: longMinutes * 60_000,
  }), [trade, orders, rapidSeconds, longMinutes]);
  const rows = allRows.filter(row => asOfTime === undefined || (trade.entries?.length
    ? trade.entries.some(entry => entry.sourceOrderId === row.orderId &&
      Number.isFinite(Date.parse(entry.entryTime ?? "")) && Date.parse(entry.entryTime ?? "") <= asOfTime)
    : Number.isFinite(Date.parse(trade.entryTime ?? "")) && Date.parse(trade.entryTime ?? "") <= asOfTime));
  if (allRows.length === 0) return null;

  return <details className="order-behavior-panel" open>
    <summary><strong>入场挂单分析</strong><span>按开仓／加仓订单 · 时间 UTC+8</span></summary>
    <div className="order-behavior-rules">
      <label>快速成交 ≤ <input type="number" aria-label="快速成交阈值（秒）" min={1} max={3600}
        value={rapidSeconds} onChange={event => {
          const value = event.currentTarget.valueAsNumber;
          if (!Number.isFinite(value)) return;
          const next = Math.min(3600, Math.max(1, Math.trunc(value)));
          setRapidSeconds(next);
          if (next >= longMinutes * 60) setLongMinutes(Math.floor(next / 60) + 1);
        }} /> 秒</label>
      <label>久挂 ≥ <input type="number" aria-label="久挂阈值（分钟）" min={1} max={10080}
        value={longMinutes} onChange={event => {
          const value = event.currentTarget.valueAsNumber;
          if (!Number.isFinite(value)) return;
          const next = Math.min(10080, Math.max(1, Math.trunc(value)));
          setLongMinutes(next);
          if (next * 60 <= rapidSeconds) setRapidSeconds(next * 60 - 1);
        }} /> 分钟</label>
      <small>标签描述操作迹象，不能确认用户的决策过程。</small>
    </div>
    {rows.length === 0 && <p className="order-behavior-empty">回放到入场后显示对应订单分析。</p>}
    <div className="order-behavior-list">
      {rows.map(row => <article className="order-behavior-row" key={`${row.provider}:${row.orderId}`}>
        <div className="order-behavior-row-heading">
          <span>{row.provider === "okx-swap" ? "OKX" : "Binance"} · {row.side === "BUY" ? "买入" : row.side === "SELL" ? "卖出" : "入场"} · 订单 {row.orderId}</span>
          <strong className={`order-behavior-label behavior-${row.kind}`}>{row.label}</strong>
        </div>
        <div className="order-behavior-times">
          <span>首次成交等待 <b>{duration(row.waitMs)}</b></span>
          {row.lastChangeWaitMs !== null && <span>最后改价后等待 <b>{duration(row.lastChangeWaitMs)}</b></span>}
          <span>委托 <time dateTime={row.createdAt ?? undefined}>{dateTime(row.createdAt)}</time></span>
          <span>首次成交 <time dateTime={row.firstFillTime ?? undefined}>{dateTime(row.firstFillTime)}</time></span>
          {row.lastPriceChangeTime && <span>最后改价 <time dateTime={row.lastPriceChangeTime}>{dateTime(row.lastPriceChangeTime)}</time></span>}
        </div>
        <p>{row.explanation}</p>
      </article>)}
    </div>
  </details>;
}

function duration(ms: number | null) {
  if (ms === null) return "未知";
  if (ms > 0 && ms < 1000) return "不足1秒";
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  return `${days ? `${days}天` : ""}${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分` : ""}${remainder || seconds === 0 ? `${remainder}秒` : ""}`;
}
function dateTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未知";
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
