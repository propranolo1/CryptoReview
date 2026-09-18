"use client";

import { useId, useState, type CSSProperties } from "react";
import styles from "./PerformanceDistributionCharts.module.css";

type ProfitPercentDistributionBin = {
  minPercent: number;
  maxPercent: number;
  centerPercent: number;
  count: number;
};

type PerformanceDistributionChartsProps = {
  bins: ProfitPercentDistributionBin[];
  averageWinHoldingMs: number | null;
  averageLossHoldingMs: number | null;
  winHoldingSamples: number;
  lossHoldingSamples: number;
  itemLabel?: string;
};

type HoldingBarStyle = CSSProperties & {
  "--holding-width": string;
};

const WIDTH = 720;
const HEIGHT = 238;
const PLOT = { left: 66, right: 20, top: 20, bottom: 48 };
const PLOT_WIDTH = WIDTH - PLOT.left - PLOT.right;
const PLOT_HEIGHT = HEIGHT - PLOT.top - PLOT.bottom;

function formatPercent(value: number, digits = 2) {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

function formatDuration(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const totalMinutes = Math.max(0, Math.round(value / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes === 0 ? `${totalHours} 小时` : `${totalHours} 小时 ${minutes} 分`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`;
}

function holdingBarStyle(value: number | null, maximum: number): HoldingBarStyle {
  const ratio = value === null || maximum <= 0 ? 0 : Math.min(1, value / maximum);
  return { "--holding-width": `${Math.max(0, ratio * 100)}%` };
}

export function PerformanceDistributionCharts({
  bins: sourceBins,
  averageWinHoldingMs,
  averageLossHoldingMs,
  winHoldingSamples,
  lossHoldingSamples,
  itemLabel = "交易",
}: PerformanceDistributionChartsProps) {
  const [detail, setDetail] = useState(30);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tooltipId = useId();
  // 只合并相邻的等宽区间，不用区间中心重新推测交易收益。
  const groupSize = Math.max(1, Math.ceil(sourceBins.length / detail));
  const bins: ProfitPercentDistributionBin[] = [];
  for (let index = 0; index < sourceBins.length; index += groupSize) {
    const group = sourceBins.slice(index, index + groupSize);
    const minPercent = group[0].minPercent;
    const maxPercent = group.at(-1)!.maxPercent;
    bins.push({ minPercent, maxPercent, centerPercent: (minPercent + maxPercent) / 2,
      count: group.reduce((sum, bin) => sum + bin.count, 0) });
  }
  const minimumPercent = bins[0]?.minPercent ?? 0;
  const maximumPercent = bins.at(-1)?.maxPercent ?? 0;
  const percentRange = maximumPercent - minimumPercent;
  const binWidth = bins[0] ? bins[0].maxPercent - bins[0].minPercent : 0;
  const digits = binWidth > 0 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(binWidth)) + 1)) : 2;
  const totalCount = bins.reduce((sum, bin) => sum + bin.count, 0);
  const activeBin = activeIndex === null ? undefined : bins[activeIndex];
  const maximumCount = Math.max(1, ...bins.map((bin) => bin.count));
  const toX = (value: number) => percentRange === 0
    ? PLOT.left + PLOT_WIDTH / 2
    : PLOT.left + ((value - minimumPercent) / percentRange) * PLOT_WIDTH;
  const toY = (count: number) =>
    PLOT.top + (1 - count / maximumCount) * PLOT_HEIGHT;
  const points = bins.map((bin) => ({
    ...bin,
    x: toX(bin.centerPercent),
    y: toY(bin.count),
  }));
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  const slotWidth = bins.length <= 1 ? PLOT_WIDTH * 0.18 : PLOT_WIDTH / bins.length;
  const barWidth = Math.max(2, Math.min(42, slotWidth * 0.72));
  const yTicks = [...new Set(Array.from({ length: 5 }, (_, index) => Math.round(maximumCount * index / 4)))];
  const xTicks = percentRange === 0 ? [minimumPercent]
    : Array.from({ length: 5 }, (_, index) => minimumPercent + percentRange * index / 4);
  const zeroX = minimumPercent <= 0 && maximumPercent >= 0 ? toX(0) : null;
  const maximumHoldingMs = Math.max(
    averageWinHoldingMs ?? 0,
    averageLossHoldingMs ?? 0,
  );

  return (
    <div className={styles.analyticsGrid}>
      <article className={styles.chartCard}>
        <header className={styles.chartHeading}>
          <div>
            <strong>损益分布曲线</strong>
            <span>利润百分比 · 交易次数 · {totalCount} 笔</span>
          </div>
          <div className={styles.detailControls} role="group" aria-label="损益分布粒度">
            {[15, 30, 60].map((count) => (
              <button key={count} type="button" aria-pressed={detail === count}
                onClick={() => { setDetail(count); setActiveIndex(null); }}>
                {count} 档
              </button>
            ))}
          </div>
        </header>
        <div className={styles.distributionFrame}>
        <svg
          className={styles.distributionCurve}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="group"
          aria-label="损益分布曲线，横轴利润百分比，纵轴交易次数"
        >
          {yTicks.map((count) => (
            <g key={count}>
              <line className={styles.gridLine} x1={PLOT.left} y1={toY(count)} x2={WIDTH - PLOT.right} y2={toY(count)} />
              <text className={styles.axisText} x={PLOT.left - 10} y={toY(count) + 4} textAnchor="end">{count}</text>
            </g>
          ))}
          <line className={styles.axisLine} x1={PLOT.left} y1={PLOT.top + PLOT_HEIGHT} x2={WIDTH - PLOT.right} y2={PLOT.top + PLOT_HEIGHT} />
          {zeroX !== null && (
            <line className={styles.zeroLine} x1={zeroX} y1={PLOT.top} x2={zeroX} y2={PLOT.top + PLOT_HEIGHT} />
          )}
          <text
            className={styles.axisTitle}
            x={16}
            y={PLOT.top + PLOT_HEIGHT / 2}
            textAnchor="middle"
            transform={`rotate(-90 16 ${PLOT.top + PLOT_HEIGHT / 2})`}
          >
            交易次数
          </text>
          {points.map((point, index) => {
            const height = PLOT.top + PLOT_HEIGHT - point.y;
            const rangeLabel = point.minPercent === point.maxPercent
              ? formatPercent(point.minPercent, digits)
              : `${formatPercent(point.minPercent, digits)}（含）至 ${formatPercent(point.maxPercent, digits)}（${index === bins.length - 1 ? "含" : "不含"}）`;
            return (
              <g
                className={styles.distributionDatum}
                key={`${point.minPercent}-${point.maxPercent}-${index}`}
                role="img"
                aria-label={`${rangeLabel}，${point.count} 笔${itemLabel}`}
                aria-describedby={activeIndex === index ? tooltipId : undefined}
                tabIndex={0}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <rect className={styles.hitArea}
                  x={bins.length === 1 ? PLOT.left : toX(point.minPercent)} y={PLOT.top}
                  width={bins.length === 1 ? PLOT_WIDTH : slotWidth} height={PLOT_HEIGHT} />
                <rect
                  className={point.minPercent < 0 && point.maxPercent > 0 ? styles.mixedBin : point.centerPercent < 0 ? styles.lossBin : styles.profitBin}
                  x={point.x - barWidth / 2}
                  y={PLOT.top + PLOT_HEIGHT - height}
                  width={barWidth}
                  height={height}
                  rx={Math.min(5, barWidth / 4)}
                />
                <circle
                  className={point.centerPercent < 0 ? styles.lossPoint : styles.profitPoint}
                  cx={point.x}
                  cy={point.y}
                  r={bins.length === 1 ? 4.5 : bins.length > 30 ? 2 : 3}
                />
              </g>
            );
          })}
          {points.length > 1 && <polyline className={styles.distributionLine} points={polyline} />}
          {xTicks.map((value, index) => (
            <text key={index} className={styles.axisText} x={toX(value)} y={HEIGHT - 22}
              textAnchor={xTicks.length === 1 ? "middle" : index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>
              {formatPercent(value, digits)}
            </text>
          ))}
          <text className={styles.axisTitle} x={PLOT.left + PLOT_WIDTH / 2} y={HEIGHT - 4} textAnchor="middle">
            利润百分比
          </text>
        </svg>
        {activeBin && (
          <div id={tooltipId} role="tooltip" className={styles.distributionTooltip}>
            <strong>{formatPercent(activeBin.minPercent, digits)} 至 {formatPercent(activeBin.maxPercent, digits)}</strong>
            <span>{activeBin.count} 笔{itemLabel} · 占 {totalCount === 0 ? "0.0" : (activeBin.count / totalCount * 100).toFixed(1)}%</span>
            <span>{activeBin.minPercent === activeBin.maxPercent ? "相同收益" : activeIndex === bins.length - 1 ? "含左右端点" : "含左端点，不含右端点"}</span>
          </div>
        )}
        </div>
        <p className={styles.distributionNote}>
          {totalCount === 0 ? "暂无已平仓记录" : `当前 ${bins.length} 档 · 每档 ${formatPercent(binWidth, digits).replace("+", "")} · 悬停查看区间笔数与占比`}
        </p>
      </article>

      <article className={styles.chartCard}>
        <header className={styles.chartHeading}>
          <div>
            <strong>持仓时间分布</strong>
            <span>分别比较盈利与亏损{itemLabel}的平均持仓时间</span>
          </div>
        </header>
        <div className={styles.holdingBars} role="group" aria-label="盈利与亏损平均持仓时间">
          <section className={styles.holdingRow}>
            <div>
              <span>盈利平均持仓时间</span>
              <strong className={styles.profitText}>{formatDuration(averageWinHoldingMs)}</strong>
              <small>{winHoldingSamples} 笔有效样本</small>
            </div>
            <div className={styles.holdingTrack} aria-hidden="true">
              <i className={styles.profitHoldingBar} style={holdingBarStyle(averageWinHoldingMs, maximumHoldingMs)} />
            </div>
          </section>
          <section className={styles.holdingRow}>
            <div>
              <span>亏损平均持仓时间</span>
              <strong className={styles.lossText}>{formatDuration(averageLossHoldingMs)}</strong>
              <small>{lossHoldingSamples} 笔有效样本</small>
            </div>
            <div className={styles.holdingTrack} aria-hidden="true">
              <i className={styles.lossHoldingBar} style={holdingBarStyle(averageLossHoldingMs, maximumHoldingMs)} />
            </div>
          </section>
        </div>
        <p className={styles.holdingNote}>
          仅统计具有有效开仓和最终平仓时间的记录；平手记录不进入盈利或亏损平均值。
        </p>
      </article>
    </div>
  );
}
