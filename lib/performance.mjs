import { calculateTradePnl } from "./trade.mjs";

const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;
const QUANTITY_EPSILON = 1e-10;

/**
 * 将单笔利润百分比转换为等宽频数分布，供真实交易与训练表现共用。
 */
export function buildProfitPercentDistribution(values, maximumBins = 12) {
  if (!Array.isArray(values)) {
    throw new TypeError("利润百分比必须是数组");
  }
  if (!Number.isInteger(maximumBins) || maximumBins <= 0) {
    throw new RangeError("最大分箱数必须是正整数");
  }
  const normalized = values.map((value, index) =>
    finiteNumber(value, `第 ${index + 1} 个利润百分比`)
  );
  if (normalized.length === 0) return [];

  const minimum = Math.min(...normalized);
  const maximum = Math.max(...normalized);
  if (minimum === maximum) {
    return [{
      minPercent: cleanNumber(minimum),
      maxPercent: cleanNumber(maximum),
      centerPercent: cleanNumber(minimum),
      count: normalized.length,
    }];
  }

  const binCount = Math.min(
    maximumBins,
    Math.max(2, Math.ceil(Math.sqrt(normalized.length) * 2)),
  );
  const step = (maximum - minimum) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => {
    const minPercent = minimum + step * index;
    const maxPercent = index === binCount - 1
      ? maximum
      : minimum + step * (index + 1);
    return {
      minPercent: cleanNumber(minPercent),
      maxPercent: cleanNumber(maxPercent),
      centerPercent: cleanNumber((minPercent + maxPercent) / 2),
      count: 0,
    };
  });

  for (const value of normalized) {
    const index = Math.min(
      binCount - 1,
      Math.floor((value - minimum) / step),
    );
    bins[index].count += 1;
  }
  return bins;
}

/**
 * 返回一笔交易最终有效的平仓时间（Unix 毫秒）。
 * 优先使用 exits 中时间最晚的有效成交，旧记录则兼容顶层 exitTime。
 */
export function getTradeCloseTime(trade) {
  if (!isRecord(trade)) return null;
  if (isRecord(trade.openPosition)) return null;

  if (Array.isArray(trade.exits)) {
    const exitTimes = trade.exits
      .map((exit) => toUnixMilliseconds(exit?.exitTime))
      .filter((time) => time !== null);

    if (exitTimes.length > 0) {
      return Math.max(...exitTimes);
    }
  }

  return toUnixMilliseconds(trade.exitTime);
}

/**
 * 以固定 UTC+8 生成最终平仓日期键，不受运行机器时区影响。
 */
export function getTradeCloseDateKey(trade) {
  const closeTime = getTradeCloseTime(trade);
  return closeTime === null
    ? null
    : new Date(closeTime + UTC_8_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 按最终平仓日期筛选交易。同一 id 使用输入中最后出现的记录。
 * “全部”包含尚无最终平仓时间的交易；具体日期仍只收录已平仓交易。
 */
export function filterTradesByCloseDate(trades, dateKey) {
  if (dateKey === null) {
    const deduplicated = deduplicateTrades(trades);
    const unclosedTrades = deduplicated.filter(
      (trade) => getTradeCloseTime(trade) === null,
    );
    return [
      ...unclosedTrades,
      ...archiveEntries(deduplicated).map((entry) => entry.trade),
    ];
  }
  assertDateKey(dateKey);
  return archiveEntries(trades)
    .filter((entry) => entry.date === dateKey)
    .map((entry) => entry.trade);
}

/**
 * 按最终平仓日从新到旧归档，组内交易也按最终平仓时间从新到旧排列。
 */
export function groupTradesByCloseDate(trades) {
  const groups = new Map();

  for (const entry of archiveEntries(trades)) {
    let group = groups.get(entry.date);
    if (!group) {
      group = { date: entry.date, trades: [], count: 0 };
      groups.set(entry.date, group);
    }
    group.trades.push(entry.trade);
    group.count += 1;
  }

  return [...groups.values()];
}

/**
 * 统计已完全平仓且具有有效最终平仓时间的交易表现。
 */
export function calculateTradePerformance(trades) {
  const closedEntries = deduplicateTrades(trades)
    .filter((trade) => isFullyClosed(trade))
    .map((trade) => {
      const time = getTradeCloseTime(trade);
      if (time === null) return null;

      const pnlResult = calculateTradePnl(trade);
      const pnl = cleanNumber(pnlResult.totalPnl);
      const openTime = getTradeOpenTime(trade);
      return {
        trade,
        tradeId: trade.id,
        date: closeDateKeyFromTime(time),
        time,
        pnl,
        returnPercent: cleanNumber(pnlResult.returnRatePercent),
        holdingMs: openTime !== null && openTime <= time ? time - openTime : null,
        fee: recordedTradeFee(trade),
        feesKnown: trade.feesKnown !== false,
      };
    })
    .filter((entry) => entry !== null)
    .sort(comparePerformanceEntries);

  let cumulativePnl = 0;
  const points = closedEntries.map((entry) => {
    cumulativePnl = cleanNumber(cumulativePnl + entry.pnl);
    return {
      tradeId: entry.tradeId,
      date: entry.date,
      time: entry.time,
      pnl: entry.pnl,
      cumulativePnl,
    };
  });

  const dailyByDate = new Map();
  let winPnl = 0;
  let lossPnl = 0;
  let wins = 0;
  let losses = 0;
  let totalFees = 0;
  let knownFeeTrades = 0;
  let unknownFeeTrades = 0;
  let winHoldingTotalMs = 0;
  let lossHoldingTotalMs = 0;
  let winHoldingSamples = 0;
  let lossHoldingSamples = 0;

  for (const entry of closedEntries) {
    let daily = dailyByDate.get(entry.date);
    if (!daily) {
      daily = {
        date: entry.date,
        pnl: 0,
        trades: 0,
        wins: 0,
        losses: 0,
      };
      dailyByDate.set(entry.date, daily);
    }

    daily.pnl = cleanNumber(daily.pnl + entry.pnl);
    daily.trades += 1;
    totalFees = cleanNumber(totalFees + entry.fee);
    if (entry.feesKnown) {
      knownFeeTrades += 1;
    } else {
      unknownFeeTrades += 1;
    }

    if (entry.pnl > 0) {
      wins += 1;
      winPnl = cleanNumber(winPnl + entry.pnl);
      daily.wins += 1;
      if (entry.holdingMs !== null) {
        winHoldingTotalMs += entry.holdingMs;
        winHoldingSamples += 1;
      }
    } else if (entry.pnl < 0) {
      losses += 1;
      lossPnl = cleanNumber(lossPnl + entry.pnl);
      daily.losses += 1;
      if (entry.holdingMs !== null) {
        lossHoldingTotalMs += entry.holdingMs;
        lossHoldingSamples += 1;
      }
    }
  }

  const daily = [...dailyByDate.values()].sort((left, right) =>
    compareStrings(left.date, right.date),
  );
  const closedTrades = closedEntries.length;
  const averageWin = wins === 0 ? 0 : cleanNumber(winPnl / wins);
  const averageLoss = losses === 0 ? 0 : cleanNumber(lossPnl / losses);
  const profitLossRatio =
    wins === 0 || losses === 0
      ? null
      : cleanNumber(averageWin / Math.abs(averageLoss));

  return {
    points,
    daily,
    totalPnl: cleanNumber(cumulativePnl),
    totalFees: cleanNumber(totalFees),
    knownFeeTrades,
    unknownFeeTrades,
    closedTrades,
    wins,
    losses,
    winRate:
      closedTrades === 0 ? 0 : cleanNumber((wins / closedTrades) * 100),
    averageWin,
    averageLoss,
    profitLossRatio,
    profitPercentDistribution: buildProfitPercentDistribution(
      closedEntries.map((entry) => entry.returnPercent),
    ),
    averageWinHoldingMs: winHoldingSamples === 0
      ? null
      : cleanNumber(winHoldingTotalMs / winHoldingSamples),
    averageLossHoldingMs: lossHoldingSamples === 0
      ? null
      : cleanNumber(lossHoldingTotalMs / lossHoldingSamples),
    winHoldingSamples,
    lossHoldingSamples,
  };
}

/**
 * 将每日表现转换为按自然月分组的日历网格。
 *
 * 每周固定以周一开始；月份首尾不足一周的位置使用 null 补齐。
 * 首个有记录日期至最后一个有记录日期之间的无交易日会保留为 0，
 * 同一首尾月份中落在该范围之外的自然日则以 inRange=false 标记。
 */
export function buildDailyPerformanceCalendar(daily) {
  if (!Array.isArray(daily)) {
    throw new TypeError("每日交易表现必须是数组");
  }
  if (daily.length === 0) return [];

  const dailyByDate = new Map();
  for (const [index, item] of daily.entries()) {
    if (!isRecord(item)) {
      throw new TypeError(`第 ${index + 1} 个每日交易表现必须是对象`);
    }

    const dateParts = parseDateKey(item.date);
    if (dateParts === null) {
      throw new TypeError(`第 ${index + 1} 个每日交易表现缺少有效日期`);
    }

    const pnl = finiteNumber(item.pnl, `第 ${index + 1} 日盈亏`);
    const trades = nonNegativeInteger(item.trades, `第 ${index + 1} 日交易数`);
    const wins = nonNegativeInteger(item.wins, `第 ${index + 1} 日盈利数`);
    const losses = nonNegativeInteger(item.losses, `第 ${index + 1} 日亏损数`);
    dailyByDate.set(item.date, {
      date: item.date,
      pnl: cleanNumber(pnl),
      trades,
      wins,
      losses,
    });
  }

  const dateKeys = [...dailyByDate.keys()].sort(compareStrings);
  const firstDate = dateKeys[0];
  const lastDate = dateKeys.at(-1);
  const firstParts = parseDateKey(firstDate);
  const lastParts = parseDateKey(lastDate);
  const firstMonthIndex = firstParts.year * 12 + firstParts.month - 1;
  const lastMonthIndex = lastParts.year * 12 + lastParts.month - 1;
  const months = [];

  for (
    let monthIndex = firstMonthIndex;
    monthIndex <= lastMonthIndex;
    monthIndex += 1
  ) {
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const leadingEmptyDays = (firstWeekday + 6) % 7;
    const calendarDays = Array.from({ length: leadingEmptyDays }, () => null);

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = formatDateKey(year, month, day);
      const performance = dailyByDate.get(date);
      const inRange = date >= firstDate && date <= lastDate;
      calendarDays.push({
        date,
        day,
        pnl: performance?.pnl ?? 0,
        trades: performance?.trades ?? 0,
        wins: performance?.wins ?? 0,
        losses: performance?.losses ?? 0,
        hasTrades: Boolean(performance && performance.trades > 0),
        inRange,
      });
    }

    while (calendarDays.length % 7 !== 0) {
      calendarDays.push(null);
    }

    const weeks = [];
    for (let index = 0; index < calendarDays.length; index += 7) {
      weeks.push(calendarDays.slice(index, index + 7));
    }

    months.push({
      key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
      label: `${year}年${month}月`,
      weeks,
    });
  }

  return months;
}

function recordedTradeFee(trade) {
  let total = nonNegativeFiniteNumber(trade.fee, "交易手续费");

  if (Array.isArray(trade.exits) && trade.exits.length > 0) {
    for (const [index, exit] of trade.exits.entries()) {
      total += nonNegativeFiniteNumber(
        exit?.fee,
        `第 ${index + 1} 笔退出手续费`,
      );
    }
  } else {
    total += nonNegativeFiniteNumber(trade.exitFee, "退出手续费");
  }

  return cleanNumber(total);
}

function archiveEntries(trades) {
  return deduplicateTrades(trades)
    .map((trade) => {
      const time = getTradeCloseTime(trade);
      if (time === null) return null;
      return {
        trade,
        time,
        date: closeDateKeyFromTime(time),
      };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => {
      if (left.time !== right.time) return right.time - left.time;
      return compareStrings(left.trade.id, right.trade.id);
    });
}

function getTradeOpenTime(trade) {
  const times = [];
  const topLevelTime = toUnixMilliseconds(trade.entryTime);
  if (topLevelTime !== null) times.push(topLevelTime);
  if (Array.isArray(trade.entries)) {
    for (const entry of trade.entries) {
      const time = toUnixMilliseconds(entry?.entryTime);
      if (time !== null) times.push(time);
    }
  }
  return times.length === 0 ? null : Math.min(...times);
}

function deduplicateTrades(trades) {
  if (!Array.isArray(trades)) {
    throw new TypeError("交易记录必须是数组");
  }

  const byId = new Map();
  for (const [index, trade] of trades.entries()) {
    if (!isRecord(trade)) {
      throw new TypeError(`第 ${index + 1} 笔交易必须是对象`);
    }
    if (typeof trade.id !== "string" || trade.id.trim() === "") {
      throw new TypeError(`第 ${index + 1} 笔交易缺少有效 id`);
    }

    // 删除后重新插入，让重复 id 的最后一份记录也保留其最新输入顺序。
    byId.delete(trade.id);
    byId.set(trade.id, trade);
  }
  return [...byId.values()];
}

function isFullyClosed(trade) {
  const quantity = positiveFiniteNumberOrNull(trade.quantity);
  if (quantity === null) return false;

  if (Array.isArray(trade.exits) && trade.exits.length > 0) {
    let exitedQuantity = 0;
    for (const exit of trade.exits) {
      const exitQuantity = positiveFiniteNumberOrNull(exit?.quantity);
      if (exitQuantity === null) return false;
      exitedQuantity += exitQuantity;
    }
    return quantitiesEqual(exitedQuantity, quantity);
  }

  if (positiveFiniteNumberOrNull(trade.exitPrice) === null) return false;
  const exitQuantity =
    trade.exitQuantity === undefined ||
    trade.exitQuantity === null ||
    trade.exitQuantity === ""
      ? quantity
      : positiveFiniteNumberOrNull(trade.exitQuantity);
  return exitQuantity !== null && quantitiesEqual(exitQuantity, quantity);
}

function quantitiesEqual(left, right) {
  return (
    Math.abs(left - right) <=
    Math.max(1, Math.abs(left), Math.abs(right)) * QUANTITY_EPSILON
  );
}

function positiveFiniteNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeFiniteNumber(value, label) {
  if (value === undefined || value === null || value === "") return 0;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${label}必须是大于或等于 0 的有限数字`);
  }
  return number;
}

function finiteNumber(value, label) {
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label}必须是有限数字`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < 0) {
    throw new RangeError(`${label}必须是大于或等于 0 的整数`);
  }
  return number;
}

function toUnixMilliseconds(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const time = Date.parse(value.trim());
  return Number.isFinite(time) ? time : null;
}

function closeDateKeyFromTime(time) {
  return new Date(time + UTC_8_OFFSET_MS).toISOString().slice(0, 10);
}

function assertDateKey(dateKey) {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new TypeError("归档日期必须使用 YYYY-MM-DD 格式");
  }
}

function parseDateKey(dateKey) {
  if (typeof dateKey !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function formatDateKey(year, month, day) {
  return [year, month, day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function comparePerformanceEntries(left, right) {
  if (left.time !== right.time) return left.time - right.time;
  return compareStrings(left.tradeId, right.tradeId);
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanNumber(value) {
  const cleaned = Number(value.toFixed(12));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}
