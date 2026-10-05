"use client";

import { getUnreplayedSmartMoneyPositions } from "@/lib/smart-money-positions.mjs";
import type { TradeProfile } from "@/lib/trade-profiles.mjs";

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 12 });
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function SmartMoneyPositions({ profile, trades }: { profile: TradeProfile; trades: unknown }) {
  const snapshot = getUnreplayedSmartMoneyPositions(profile, trades);
  if (!snapshot) return null;
  return (
    <section className="smart-money-positions" aria-label="历史不完整的当前持仓">
      <div className="smart-money-positions-heading">
        <strong>当前持仓</strong><span>{snapshot.positions.length} 个待补齐</span>
      </div>
      <p className="smart-money-positions-note">历史不完整，暂不能回放；不计入复盘笔数和总盈亏。</p>
      <div className="smart-money-positions-list" role="list" aria-label="待补齐持仓">
        {snapshot.positions.map(position => (
          <article className="smart-money-position" key={`${position.symbol}:${position.positionSide}`} role="listitem">
            <div className="smart-money-position-heading">
              <strong>{position.symbol.replace(/(USDT|USDC|BUSD)$/, "/$1")}</strong>
              <span className={position.positionSide === "LONG" ? "side-badge long"
                : position.positionSide === "SHORT" ? "side-badge short" : ""}>
                {position.positionSide === "LONG" ? "多" : position.positionSide === "SHORT" ? "空" : "方向未知"}
              </span>
            </div>
            <span className="smart-money-position-warning">历史不完整</span>
            <dl>
              <div><dt>持仓数量</dt><dd>{numberFormat.format(position.quantity)}</dd></div>
              <div><dt>开仓均价</dt><dd>{numberFormat.format(position.entryPrice)}</dd></div>
            </dl>
          </article>
        ))}
      </div>
      <div className="smart-money-positions-time">
        {profile.smartMoneySource?.lastError ? "更新未成功 · 最近同步 " : "最近同步 "}
        <time dateTime={snapshot.fetchedAt} title={`${snapshot.fetchedAt}（显示为北京时间）`}>
          {timeFormat.format(new Date(snapshot.fetchedAt))}
        </time>
        <span>（北京时间）</span>
      </div>
    </section>
  );
}
