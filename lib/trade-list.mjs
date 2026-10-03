import { calculateTradePnl } from "./trade.mjs";
import { getTradeCloseTime } from "./performance.mjs";
import { getTradeToken } from "./trade-index.mjs";

/** 仅整理已筛选的列表，不改变原交易、盈亏规则或当前选择。 */
export function buildTradeListRows(trades, { sortBy = "default", direction = "desc", now = Date.now() } = {}) {
  const rows = trades.map((trade, index) => {
    let pnl = null;
    try {
      const price = trade.openPosition?.markPrice ?? trade.exits?.at(-1)?.exitPrice ?? trade.entryPrice;
      pnl = calculateTradePnl(trade, price);
      if (!Number.isFinite(pnl.totalPnl)) pnl = null;
    } catch {
      // 损坏的旧记录不参与金额排序或颜色尺度，仍保留在列表中。
    }
    const amount = pnl?.totalPnl ?? 0;
    return { trade, pnl, holdingMs: holdingTime(trade, now),
      tone: amount > 0 ? "profit" : amount < 0 ? "loss" : "neutral", intensity: 0, index };
  });
  const maximum = rows.reduce((value, row) => Math.max(value, Math.abs(row.pnl?.totalPnl ?? 0)), 0);
  for (const row of rows) {
    row.intensity = maximum > 0 ? Math.sqrt(Math.abs(row.pnl?.totalPnl ?? 0) / maximum) : 0;
  }
  const sign = direction === "asc" ? 1 : -1;
  if (["date", "holding", "pnl"].includes(sortBy)) {
    const value = (row) => sortBy === "holding" ? row.holdingMs
      : sortBy === "pnl" ? row.pnl?.totalPnl ?? null
        : row.trade.openPosition ? openTime(row.trade) : getTradeCloseTime(row.trade);
    rows.sort((left, right) => {
      const a = value(left), b = value(right);
      if (a === null || b === null) return a === b ? left.index - right.index : a === null ? 1 : -1;
      return sign * (a - b) || left.index - right.index;
    });
  }
  return rows.map(({ index, ...row }) => row);
}

/** 与列表使用同一盈亏口径；输入由调用方限定为当前复盘用户。 */
export function summarizeTradeListByToken(trades) {
  const groups = new Map();
  for (const { trade, pnl } of buildTradeListRows(trades)) {
    const token = getTradeToken(trade.symbol);
    if (!token) continue;
    const group = groups.get(token) ?? { token, count: 0, totalPnl: 0, hasOpenPositions: false };
    group.count += 1;
    group.totalPnl = group.totalPnl === null || pnl === null ? null : group.totalPnl + pnl.totalPnl;
    group.hasOpenPositions ||= Boolean(trade.openPosition);
    groups.set(token, group);
  }
  return [...groups.values()].sort((left, right) => left.token.localeCompare(right.token, "zh-CN"));
}

function holdingTime(trade, now) {
  const start = openTime(trade);
  const end = trade.openPosition ? parseTime(now) : getTradeCloseTime(trade);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function parseTime(value) {
  const time = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function openTime(trade) {
  const times = [trade.entryTime, ...(Array.isArray(trade.entries) ? trade.entries : []).map((entry) => entry?.entryTime)]
    .map(parseTime).filter((time) => time !== null);
  if (times.length === 0) return null;
  return times.reduce((earliest, time) => Math.min(earliest, time), Infinity);
}

export function formatTradeHoldingTime(milliseconds) {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "不足 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`;
}
