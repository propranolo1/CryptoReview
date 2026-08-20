import type { CSSProperties } from "react";
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

function formatPercent(value: number) {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
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
  bins,
  averageWinHoldingMs,
  averageLossHoldingMs,
  winHoldingSamples,
  lossHoldingSamples,
  itemLabel = "交易",
}: PerformanceDistributionChartsProps) {
  const minimumPercent = bins[0]?.minPercent ?? 0;
  const maximumPercent = bins.at(-1)?.maxPercent ?? 0;
  const percentRange = maximumPercent - minimumPercent;
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
  const barWidth = Math.max(5, Math.min(42, slotWidth * 0.58));
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
            <span>横轴为利润百分比，纵轴为交易次数</span>
          </div>
          <em>{bins.reduce((sum, bin) => sum + bin.count, 0)} 笔</em>
        </header>
        <svg
          className={styles.distributionCurve}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="损益分布曲线，横轴利润百分比，纵轴交易次数"
        >
          <line className={styles.gridLine} x1={PLOT.left} y1={PLOT.top} x2={WIDTH - PLOT.right} y2={PLOT.top} />
          <line className={styles.axisLine} x1={PLOT.left} y1={PLOT.top + PLOT_HEIGHT} x2={WIDTH - PLOT.right} y2={PLOT.top + PLOT_HEIGHT} />
          {zeroX !== null && (
            <line className={styles.zeroLine} x1={zeroX} y1={PLOT.top} x2={zeroX} y2={PLOT.top + PLOT_HEIGHT} />
          )}
          <text className={styles.axisText} x={PLOT.left - 10} y={PLOT.top + 4} textAnchor="end">{maximumCount}</text>
          <text className={styles.axisText} x={PLOT.left - 10} y={PLOT.top + PLOT_HEIGHT + 4} textAnchor="end">0</text>
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
            const height = Math.max(1, PLOT.top + PLOT_HEIGHT - point.y);
            return (
              <g
                className={styles.distributionDatum}
                key={`${point.minPercent}-${point.maxPercent}-${index}`}
                role="img"
                aria-label={`${formatPercent(point.minPercent)} 至 ${formatPercent(point.maxPercent)}，${point.count} 笔${itemLabel}`}
                tabIndex={0}
              >
                <title>{formatPercent(point.minPercent)} 至 {formatPercent(point.maxPercent)} · {point.count} 笔{itemLabel}</title>
                <rect
                  className={point.centerPercent < 0 ? styles.lossBin : styles.profitBin}
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
                  r={bins.length === 1 ? 4.5 : 3.5}
                />
              </g>
            );
          })}
          {points.length > 1 && <polyline className={styles.distributionLine} points={polyline} />}
          <text className={styles.axisText} x={PLOT.left} y={HEIGHT - 22} textAnchor="start">
            {formatPercent(minimumPercent)}
          </text>
          {zeroX !== null && minimumPercent !== 0 && maximumPercent !== 0 && (
            <text className={styles.zeroText} x={zeroX} y={HEIGHT - 22} textAnchor="middle">0%</text>
          )}
          <text className={styles.axisText} x={WIDTH - PLOT.right} y={HEIGHT - 22} textAnchor="end">
            {formatPercent(maximumPercent)}
          </text>
          <text className={styles.axisTitle} x={PLOT.left + PLOT_WIDTH / 2} y={HEIGHT - 4} textAnchor="middle">
            利润百分比
          </text>
        </svg>
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
