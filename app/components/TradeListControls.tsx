"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { TradeListDirection, TradeListSort } from "@/lib/trade-list.mjs";

const SORT_OPTIONS: { value: TradeListSort; label: string }[] = [
  { value: "date", label: "按日期" },
  { value: "holding", label: "按持有时间" },
  { value: "pnl", label: "按盈亏金额" },
];

type Props = {
  tokens: { token: string; count: number }[];
  selectedToken: string | null;
  starredOnly: boolean;
  starredCount: number;
  sortBy: TradeListSort;
  direction: TradeListDirection;
  tradeCount: number;
  totalPnl: number | null;
  formattedTotal: string;
  hasOpenPositions: boolean;
  onTokenChange: (token: string | null) => void;
  onStarredChange: (enabled: boolean) => void;
  onSortChange: (sort: TradeListSort) => void;
  onDirectionChange: () => void;
};

export function TradeListControls(props: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const scope = props.starredOnly ? "星标交易" : props.selectedToken ?? "全部代币";
  const sortLabel = SORT_OPTIONS.find(option => option.value === props.sortBy)?.label ?? "按日期";
  const summary = `${scope} · ${sortLabel}`;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="trade-list-controls" ref={rootRef}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <div className="trade-list-toolbar">
        <button ref={triggerRef} type="button" className="trade-list-picker"
          aria-label={`交易筛选与排序：${summary}`} aria-expanded={open}
          aria-haspopup="dialog" aria-controls={panelId} title={summary}
          onClick={() => setOpen(current => !current)}>
          <span>{summary}</span><ChevronDown size={13} />
        </button>
        <button type="button" className="trade-list-direction"
          aria-label={props.direction === "desc" ? "切换为升序" : "切换为降序"}
          title={props.direction === "desc" ? "降序：从大到小" : "升序：从小到大"}
          onClick={props.onDirectionChange}>
          {props.direction === "desc" ? "↓ 降序" : "↑ 升序"}
        </button>
      </div>
      {open && (
        <div id={panelId} className="trade-list-picker-panel" role="dialog" aria-label="交易筛选与排序">
          <fieldset>
            <legend>代币</legend>
            <div className="trade-list-token-options">
              {[{ token: null, count: props.tokens.reduce((sum, token) => sum + token.count, 0) }, ...props.tokens].map(option => (
                <label key={option.token ?? "all"} className="trade-list-choice">
                  <input type="radio" name={`${panelId}-token`} aria-label={option.token ?? "全部代币"}
                    checked={!props.starredOnly && props.selectedToken === option.token}
                    onChange={() => props.onTokenChange(option.token)} />
                  <span>{option.token ?? "全部代币"}</span><small>{option.count}</small>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>排序依据</legend>
            <div className="trade-list-sort-options">
              {SORT_OPTIONS.map(option => (
                <label key={option.value} className="trade-list-choice">
                  <input type="radio" name={`${panelId}-sort`} aria-label={option.label}
                    checked={props.sortBy === option.value} onChange={() => props.onSortChange(option.value)} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="trade-list-star-filter">
            <input type="checkbox" checked={props.starredOnly} disabled={props.starredCount === 0}
              onChange={event => props.onStarredChange(event.target.checked)} />
            星标交易 <small>{props.starredCount}</small>
          </label>
        </div>
      )}
      <div className="trade-list-total" title={props.totalPnl === null ? "部分记录盈亏未知，无法计算总额"
        : props.hasOpenPositions ? "含未平仓按最新同步价格估算的盈亏" : "当前筛选范围全部交易的盈亏合计"}>
        <span>{scope} · {props.tradeCount} 笔<span className="trade-list-total-label">总盈亏</span></span>
        <strong className={props.totalPnl === null || props.totalPnl === 0 ? "neutral" : props.totalPnl > 0 ? "positive" : "negative"}>
          {props.formattedTotal}
        </strong>
      </div>
    </div>
  );
}
