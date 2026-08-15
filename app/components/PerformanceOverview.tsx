"use client";

import { useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { NormalizedTrade } from "@/lib/trade.mjs";
import {
  buildDailyPerformanceCalendar,
  calculateTradePerformance,
  getTradeCloseDateKey,
} from "@/lib/performance.mjs";
import styles from "./PerformanceOverview.module.css";

type PerformanceTrade = NormalizedTrade & {
  id: string;
  feesKnown?: boolean;
};

type PerformanceOverviewProps = {
  trades: PerformanceTrade[];
  selectedDate: string | null;
};

type ChartScale = {
  min: number;
  max: number;
  baselineY: number;
  toY: (value: number) => number;
};

type PositionedPoint = {
  x: number;
  y: number;
  value: number;
};

type CurveSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tone: "profit" | "loss";
};

type ChartTooltip = {
  key: string;
  x: number;
  y: number;
  title: string;
  lines: string[];
};

type TooltipStyle = CSSProperties & {
  "--tooltip-shift-x": string;
  "--tooltip-shift-y": string;
};

type CalendarDayStyle = CSSProperties & {
  "--calendar-intensity": string;
};

const CHART_WIDTH = 720;
const CHART_HEIGHT = 224;
const PLOT = {
  left: 62,
  right: 18,
  top: 16,
  bottom: 36,
};

const PLOT_WIDTH = CHART_WIDTH - PLOT.left - PLOT.right;
const PLOT_HEIGHT = CHART_HEIGHT - PLOT.top - PLOT.bottom;

function formatMoney(value: number, showSign = false) {
  const sign = value < 0 ? "−" : showSign && value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value))} USDT`;
}

function formatAxisMoney(value: number) {
  if (value === 0) return "0";
  const formatted = new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.abs(value));
  return `${value < 0 ? "−" : "+"}${formatted}`;
}

function formatDateLabel(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[2]}/${match[3]}` : date;
}

function formatPerformanceDateTime(time: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(time));
}

function formatCalendarMoney(value: number) {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  const absolute = Math.abs(value);
  const formatted = absolute >= 10_000
    ? new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(absolute)
    : new Intl.NumberFormat("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(absolute);
  return `${sign}${formatted}`;
}

function chartTooltipStyle(x: number, y: number): TooltipStyle {
  const shiftX = x < PLOT.left + 90
    ? "0%"
    : x > CHART_WIDTH - PLOT.right - 90
      ? "-100%"
      : "-50%";
  const shiftY = y < PLOT.top + 62 ? "10px" : "calc(-100% - 10px)";

  return {
    left: `${(x / CHART_WIDTH) * 100}%`,
    top: `${(y / CHART_HEIGHT) * 100}%`,
    "--tooltip-shift-x": shiftX,
    "--tooltip-shift-y": shiftY,
  };
}

function curveHitBand(points: PositionedPoint[], index: number) {
  const point = points[index];
  const left = index === 0
    ? PLOT.left
    : (points[index - 1].x + point.x) / 2;
  const right = index === points.length - 1
    ? CHART_WIDTH - PLOT.right
    : (point.x + points[index + 1].x) / 2;
  return { x: left, width: Math.max(1, right - left) };
}

function calendarDayStyle(value: number, maxProfit: number, maxLoss: number): CalendarDayStyle {
  const ceiling = value > 0 ? maxProfit : maxLoss;
  const ratio = ceiling === 0 ? 0 : Math.min(1, Math.abs(value) / ceiling);
  return { "--calendar-intensity": `${Math.round(8 + ratio * 34)}%` };
}

function createChartScale(values: number[]): ChartScale {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);

  if (min === max) {
    min = -1;
    max = 1;
  } else {
    const range = max - min;
    if (min < 0) min -= range * 0.08;
    if (max > 0) max += range * 0.08;
  }

  const toY = (value: number) =>
    PLOT.top + ((max - value) / (max - min)) * PLOT_HEIGHT;

  return {
    min,
    max,
    baselineY: toY(0),
    toY,
  };
}

function positionCurvePoints(values: number[], scale: ChartScale): PositionedPoint[] {
  return values.map((value, index) => ({
    x: values.length === 1
      ? PLOT.left + PLOT_WIDTH / 2
      : PLOT.left + (index / (values.length - 1)) * PLOT_WIDTH,
    y: scale.toY(value),
    value,
  }));
}

function buildCurveSegments(points: PositionedPoint[]): CurveSegment[] {
  const segments: CurveSegment[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const crossesBaseline = (start.value < 0 && end.value > 0) ||
      (start.value > 0 && end.value < 0);

    if (!crossesBaseline) {
      segments.push({
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        tone: end.value < 0 || (end.value === 0 && start.value < 0) ? "loss" : "profit",
      });
      continue;
    }

    const crossingRatio = Math.abs(start.value) /
      (Math.abs(start.value) + Math.abs(end.value));
    const crossingX = start.x + (end.x - start.x) * crossingRatio;
    const crossingY = start.y + (end.y - start.y) * crossingRatio;

    segments.push({
      x1: start.x,
      y1: start.y,
      x2: crossingX,
      y2: crossingY,
      tone: start.value < 0 ? "loss" : "profit",
    });
    segments.push({
      x1: crossingX,
      y1: crossingY,
      x2: end.x,
      y2: end.y,
      tone: end.value < 0 ? "loss" : "profit",
    });
  }

  return segments;
}

function toneClass(value: number) {
  if (value > 0) return styles.profit;
  if (value < 0) return styles.loss;
  return styles.neutral;
}

export function PerformanceOverview({
  trades,
  selectedDate,
}: PerformanceOverviewProps) {
  const titleId = useId();
  const curveTitleId = useId();
  const curveDescriptionId = useId();
  const dailyTitleId = useId();
  const dailyDescriptionId = useId();
  const curveTooltipId = useId();
  const dailyTooltipId = useId();
  const calendarTitleId = useId();
  const [curveTooltip, setCurveTooltip] = useState<ChartTooltip | null>(null);
  const [dailyTooltip, setDailyTooltip] = useState<ChartTooltip | null>(null);
  const performance = useMemo(() => calculateTradePerformance(trades), [trades]);
  const calendarMonths = useMemo(
    () => buildDailyPerformanceCalendar(performance.daily),
    [performance.daily],
  );
  const closeDateKeys = useMemo(() => {
    const dates = new Set<string>();
    for (const trade of trades) {
      const date = getTradeCloseDateKey(trade);
      if (date) dates.add(date);
    }
    return dates;
  }, [trades]);
  const hasUnknownFees = performance.unknownFeeTrades > 0;

  if (performance.closedTrades === 0 || performance.points.length === 0) {
    return (
      <section className={styles.panel} aria-labelledby={titleId}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>PERFORMANCE</span>
            <h2 id={titleId}>交易表现</h2>
          </div>
          <span className={styles.closedCount}>0 笔已平仓</span>
        </header>
        <div className={styles.emptyState}>
          <svg viewBox="0 0 96 48" aria-hidden="true">
            <path d="M5 38h86M12 31l17-9 15 5 18-17 22 8" />
          </svg>
          <strong>暂无可统计的已平仓交易</strong>
          <span>完成交易或导入包含完整开平仓的订单历史后，这里会显示累计和每日盈利表现。</span>
        </div>
        {hasUnknownFees && (
          <p className={styles.feeNotice}>部分订单历史不含手续费，后续统计将以未扣手续费的重建盈亏计算。</p>
        )}
      </section>
    );
  }

  const curveValues = performance.points.map((point) => point.cumulativePnl);
  const curveScale = createChartScale(curveValues);
  const positionedCurvePoints = positionCurvePoints(curveValues, curveScale);
  const curveSegments = buildCurveSegments(positionedCurvePoints);
  const dailyValues = performance.daily.map((item) => item.pnl);
  const dailyScale = createChartScale(dailyValues);
  const dailySlotWidth = PLOT_WIDTH / performance.daily.length;
  const dailyBarWidth = Math.max(3, Math.min(30, dailySlotWidth * 0.62));
  const selectedDaily = selectedDate && closeDateKeys.has(selectedDate)
    ? performance.daily.find((item) => item.date === selectedDate)
    : undefined;
  const firstPoint = performance.points[0];
  const lastPoint = performance.points.at(-1);
  const firstDay = performance.daily[0];
  const lastDay = performance.daily.at(-1);
  const maxCalendarProfit = Math.max(
    0,
    ...performance.daily.map((item) => Math.max(0, item.pnl)),
  );
  const maxCalendarLoss = Math.max(
    0,
    ...performance.daily.map((item) => Math.max(0, -item.pnl)),
  );

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>PERFORMANCE</span>
          <h2 id={titleId}>交易表现</h2>
        </div>
        <span className={styles.closedCount}>{performance.closedTrades} 笔已平仓</span>
      </header>

      <div className={styles.metrics}>
        <article>
          <span>总盈亏</span>
          <strong className={toneClass(performance.totalPnl)}>
            {formatMoney(performance.totalPnl, true)}
          </strong>
          <small>{performance.wins} 胜 · {performance.losses} 负</small>
        </article>
        <article>
          <span>胜率</span>
          <strong>{performance.winRate.toFixed(1)}%</strong>
          <small>基于已平仓交易</small>
        </article>
        <article>
          <span>平均盈亏比</span>
          <strong>{performance.profitLossRatio === null
            ? "—"
            : `${performance.profitLossRatio.toFixed(2)} : 1`}</strong>
          <small>
            平均赚 {formatMoney(performance.averageWin, true)} · 平均亏 {formatMoney(performance.averageLoss, true)}
          </small>
        </article>
        <article>
          <span>手续费</span>
          <strong>{formatMoney(performance.totalFees)}</strong>
          <small>{hasUnknownFees
            ? `已统计 ${performance.knownFeeTrades} 笔 · ${performance.unknownFeeTrades} 笔缺失`
            : "已平仓交易合计"}</small>
        </article>
      </div>

      <div className={styles.charts}>
        <article className={styles.chartCard}>
          <div className={styles.chartHeading}>
            <div>
              <strong>累计盈利曲线</strong>
              <span>每笔已平仓交易后的累计结果</span>
            </div>
            <em className={toneClass(performance.totalPnl)}>
              {formatMoney(performance.totalPnl, true)}
            </em>
          </div>
          <div className={styles.chartFrame}>
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="group"
              aria-labelledby={`${curveTitleId} ${curveDescriptionId}`}
            >
              <title id={curveTitleId}>累计盈利曲线</title>
              <desc id={curveDescriptionId}>
                从 {firstPoint.date} 到 {lastPoint?.date ?? firstPoint.date}，
                共 {performance.closedTrades} 笔已平仓交易，累计盈亏 {formatMoney(performance.totalPnl, true)}。
              </desc>
              <line
                className={styles.gridLine}
                x1={PLOT.left}
                y1={PLOT.top}
                x2={CHART_WIDTH - PLOT.right}
                y2={PLOT.top}
              />
              <line
                className={styles.gridLine}
                x1={PLOT.left}
                y1={PLOT.top + PLOT_HEIGHT}
                x2={CHART_WIDTH - PLOT.right}
                y2={PLOT.top + PLOT_HEIGHT}
              />
              <line
                className={styles.baseline}
                x1={PLOT.left}
                y1={curveScale.baselineY}
                x2={CHART_WIDTH - PLOT.right}
                y2={curveScale.baselineY}
              />
              {curveScale.max !== 0 && (
                <text className={styles.axisLabel} x={PLOT.left - 8} y={PLOT.top + 4} textAnchor="end">
                  {formatAxisMoney(curveScale.max)}
                </text>
              )}
              <text className={styles.axisLabel} x={PLOT.left - 8} y={curveScale.baselineY + 4} textAnchor="end">0</text>
              {curveScale.min !== 0 && (
                <text className={styles.axisLabel} x={PLOT.left - 8} y={PLOT.top + PLOT_HEIGHT} textAnchor="end">
                  {formatAxisMoney(curveScale.min)}
                </text>
              )}
              {curveSegments.map((segment, index) => (
                <line
                  key={`${segment.x1}-${segment.x2}-${index}`}
                  className={segment.tone === "profit" ? styles.profitStroke : styles.lossStroke}
                  x1={segment.x1}
                  y1={segment.y1}
                  x2={segment.x2}
                  y2={segment.y2}
                />
              ))}
              {performance.points.map((point, index) => {
                const position = positionedCurvePoints[index];
                const hitBand = curveHitBand(positionedCurvePoints, index);
                const tooltip: ChartTooltip = {
                  key: point.tradeId,
                  x: position.x,
                  y: position.y,
                  title: formatPerformanceDateTime(point.time),
                  lines: [
                    `单笔盈亏 ${formatMoney(point.pnl, true)}`,
                    `累计盈亏 ${formatMoney(point.cumulativePnl, true)}`,
                  ],
                };
                const isActive = curveTooltip?.key === point.tradeId;
                return (
                  <g
                    key={point.tradeId}
                    className={styles.chartDatum}
                    role="img"
                    aria-label={`${tooltip.title}，${tooltip.lines.join("，")}`}
                    aria-describedby={isActive ? curveTooltipId : undefined}
                    tabIndex={0}
                    onMouseEnter={() => setCurveTooltip(tooltip)}
                    onMouseLeave={() => setCurveTooltip(null)}
                    onFocus={() => setCurveTooltip(tooltip)}
                    onBlur={() => setCurveTooltip(null)}
                  >
                    <rect
                      className={styles.chartHitArea}
                      x={hitBand.x}
                      y={PLOT.top}
                      width={hitBand.width}
                      height={PLOT_HEIGHT}
                    />
                    <circle
                      className={position.value < 0 ? styles.lossPoint : styles.profitPoint}
                      cx={position.x}
                      cy={position.y}
                      r={performance.points.length === 1 ? 4 : 2.8}
                    />
                  </g>
                );
              })}
              <text className={styles.axisLabel} x={PLOT.left} y={CHART_HEIGHT - 8} textAnchor="start">
                {formatDateLabel(firstPoint.date)}
              </text>
              <text className={styles.axisLabel} x={CHART_WIDTH - PLOT.right} y={CHART_HEIGHT - 8} textAnchor="end">
                {formatDateLabel(lastPoint?.date ?? firstPoint.date)}
              </text>
            </svg>
            {curveTooltip && (
              <div
                id={curveTooltipId}
                className={styles.chartTooltip}
                role="tooltip"
                style={chartTooltipStyle(curveTooltip.x, curveTooltip.y)}
              >
                <strong>{curveTooltip.title}</strong>
                {curveTooltip.lines.map((line) => <span key={line}>{line}</span>)}
              </div>
            )}
          </div>
        </article>

        <article className={styles.chartCard}>
          <div className={styles.chartHeading}>
            <div>
              <strong>每日盈利</strong>
              <span>{selectedDaily
                ? `${selectedDaily.date} · ${selectedDaily.trades} 笔已平仓`
                : "按平仓日期汇总"}</span>
            </div>
            {selectedDaily && (
              <em className={toneClass(selectedDaily.pnl)}>{formatMoney(selectedDaily.pnl, true)}</em>
            )}
          </div>
          <div className={styles.chartFrame}>
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="group"
              aria-labelledby={`${dailyTitleId} ${dailyDescriptionId}`}
            >
              <title id={dailyTitleId}>每日盈利柱图</title>
              <desc id={dailyDescriptionId}>
                从 {firstDay.date} 到 {lastDay?.date ?? firstDay.date} 的每日已平仓盈亏；绿色为盈利，红色为亏损
                {selectedDaily ? `，当前高亮 ${selectedDaily.date}` : ""}。
              </desc>
              <line
                className={styles.gridLine}
                x1={PLOT.left}
                y1={PLOT.top}
                x2={CHART_WIDTH - PLOT.right}
                y2={PLOT.top}
              />
              <line
                className={styles.gridLine}
                x1={PLOT.left}
                y1={PLOT.top + PLOT_HEIGHT}
                x2={CHART_WIDTH - PLOT.right}
                y2={PLOT.top + PLOT_HEIGHT}
              />
              <line
                className={styles.baseline}
                x1={PLOT.left}
                y1={dailyScale.baselineY}
                x2={CHART_WIDTH - PLOT.right}
                y2={dailyScale.baselineY}
              />
              {dailyScale.max !== 0 && (
                <text className={styles.axisLabel} x={PLOT.left - 8} y={PLOT.top + 4} textAnchor="end">
                  {formatAxisMoney(dailyScale.max)}
                </text>
              )}
              <text className={styles.axisLabel} x={PLOT.left - 8} y={dailyScale.baselineY + 4} textAnchor="end">0</text>
              {dailyScale.min !== 0 && (
                <text className={styles.axisLabel} x={PLOT.left - 8} y={PLOT.top + PLOT_HEIGHT} textAnchor="end">
                  {formatAxisMoney(dailyScale.min)}
                </text>
              )}
              {performance.daily.map((item, index) => {
                const x = PLOT.left + index * dailySlotWidth +
                  (dailySlotWidth - dailyBarWidth) / 2;
                const valueY = dailyScale.toY(item.pnl);
                const y = item.pnl >= 0 ? valueY : dailyScale.baselineY;
                const height = Math.max(1.5, Math.abs(dailyScale.baselineY - valueY));
                const isSelected = item.date === selectedDate;
                const tooltip: ChartTooltip = {
                  key: item.date,
                  x: PLOT.left + (index + 0.5) * dailySlotWidth,
                  y: item.pnl >= 0 ? y : y + height,
                  title: item.date,
                  lines: [
                    `当日盈亏 ${formatMoney(item.pnl, true)}`,
                    `${item.trades} 笔交易 · ${item.wins} 胜 · ${item.losses} 负`,
                  ],
                };
                const isActive = dailyTooltip?.key === item.date;
                return (
                  <g
                    key={item.date}
                    className={styles.chartDatum}
                    role="img"
                    aria-label={`${tooltip.title}，${tooltip.lines.join("，")}`}
                    aria-describedby={isActive ? dailyTooltipId : undefined}
                    tabIndex={0}
                    onMouseEnter={() => setDailyTooltip(tooltip)}
                    onMouseLeave={() => setDailyTooltip(null)}
                    onFocus={() => setDailyTooltip(tooltip)}
                    onBlur={() => setDailyTooltip(null)}
                  >
                    {isSelected && (
                      <rect
                        className={styles.selectedBand}
                        x={PLOT.left + index * dailySlotWidth + 1}
                        y={PLOT.top}
                        width={Math.max(1, dailySlotWidth - 2)}
                        height={PLOT_HEIGHT}
                        rx={4}
                      />
                    )}
                    <rect
                      className={`${item.pnl >= 0 ? styles.profitBar : styles.lossBar} ${isSelected ? styles.selectedBar : ""}`}
                      x={x}
                      y={y}
                      width={dailyBarWidth}
                      height={height}
                      rx={Math.min(4, dailyBarWidth / 4)}
                    />
                    <rect
                      className={styles.chartHitArea}
                      x={PLOT.left + index * dailySlotWidth}
                      y={PLOT.top}
                      width={dailySlotWidth}
                      height={PLOT_HEIGHT}
                    />
                  </g>
                );
              })}
              <text className={styles.axisLabel} x={PLOT.left} y={CHART_HEIGHT - 8} textAnchor="start">
                {formatDateLabel(firstDay.date)}
              </text>
              {selectedDaily && selectedDate !== firstDay.date && selectedDate !== lastDay?.date && (
                <text
                  className={styles.selectedAxisLabel}
                  x={PLOT.left +
                    ((performance.daily.findIndex((item) => item.date === selectedDate) + 0.5) * dailySlotWidth)}
                  y={CHART_HEIGHT - 8}
                  textAnchor="middle"
                >
                  {formatDateLabel(selectedDaily.date)}
                </text>
              )}
              <text className={styles.axisLabel} x={CHART_WIDTH - PLOT.right} y={CHART_HEIGHT - 8} textAnchor="end">
                {formatDateLabel(lastDay?.date ?? firstDay.date)}
              </text>
            </svg>
            {dailyTooltip && (
              <div
                id={dailyTooltipId}
                className={styles.chartTooltip}
                role="tooltip"
                style={chartTooltipStyle(dailyTooltip.x, dailyTooltip.y)}
              >
                <strong>{dailyTooltip.title}</strong>
                {dailyTooltip.lines.map((line) => <span key={line}>{line}</span>)}
              </div>
            )}
          </div>
        </article>
      </div>

      <article className={`${styles.chartCard} ${styles.calendarCard}`} aria-labelledby={calendarTitleId}>
        <div className={styles.chartHeading}>
          <div>
            <strong id={calendarTitleId}>每日盈利日历</strong>
            <span>按最终平仓日期显示当日盈亏，金额单位为 USDT</span>
          </div>
          <div className={styles.calendarLegend} aria-label="颜色说明">
            <span><i className={styles.calendarLegendProfit} />盈利</span>
            <span><i className={styles.calendarLegendLoss} />亏损</span>
          </div>
        </div>
        <div className={styles.calendarMonths}>
          {calendarMonths.map((month) => (
            <section className={styles.calendarMonth} key={month.key} aria-label={month.label}>
              <h3>{month.label}</h3>
              <div className={styles.calendarWeekdays} aria-hidden="true">
                {[
                  "一",
                  "二",
                  "三",
                  "四",
                  "五",
                  "六",
                  "日",
                ].map((weekday) => <span key={weekday}>{weekday}</span>)}
              </div>
              <div className={styles.calendarGrid}>
                {month.weeks.flatMap((week, weekIndex) =>
                  week.map((day, dayIndex) => {
                    if (!day) {
                      return (
                        <span
                          className={styles.calendarBlank}
                          key={`${month.key}-empty-${weekIndex}-${dayIndex}`}
                          aria-hidden="true"
                        />
                      );
                    }

                    const tooltipId = `${calendarTitleId}-${day.date}`;
                    const dayClasses = [
                      styles.calendarDay,
                      day.pnl > 0
                        ? styles.calendarDayProfit
                        : day.pnl < 0
                          ? styles.calendarDayLoss
                          : styles.calendarDayNeutral,
                      !day.inRange ? styles.calendarDayOutside : "",
                      day.date === selectedDate ? styles.calendarDaySelected : "",
                    ].filter(Boolean).join(" ");
                    const summary = day.hasTrades
                      ? `${day.trades} 笔交易 · ${day.wins} 胜 · ${day.losses} 负`
                      : "当日无平仓交易";

                    return (
                      <div
                        className={dayClasses}
                        key={day.date}
                        role="img"
                        aria-label={`${day.date}，当日盈亏 ${formatMoney(day.pnl, true)}，${summary}`}
                        aria-describedby={day.inRange ? tooltipId : undefined}
                        tabIndex={day.inRange ? 0 : -1}
                        style={calendarDayStyle(day.pnl, maxCalendarProfit, maxCalendarLoss)}
                      >
                        <time dateTime={day.date}>{day.day}</time>
                        <strong className={day.inRange ? toneClass(day.pnl) : styles.calendarMuted}>
                          {day.inRange ? formatCalendarMoney(day.pnl) : "—"}
                        </strong>
                        {day.inRange && (
                          <span id={tooltipId} className={styles.calendarTooltip} role="tooltip">
                            <b>{day.date}</b>
                            <span>当日盈亏 {formatMoney(day.pnl, true)}</span>
                            <span>{summary}</span>
                          </span>
                        )}
                      </div>
                    );
                  }),
                )}
              </div>
            </section>
          ))}
        </div>
      </article>

      {hasUnknownFees && (
        <p className={styles.feeNotice}>部分订单历史不含手续费，面板中的相关盈亏为未扣手续费的重建结果。</p>
      )}
    </section>
  );
}
