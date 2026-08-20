/**
 * 根据单根 K 线内部进度，构造当前时刻已经发生的 OHLC。
 *
 * 上涨或平盘使用 O → L → H → C，下跌使用 O → H → L → C。
 * 四个确定性价位节点均匀分布在 0、1/3、2/3、1，尚未到达的
 * 高低点不会提前进入返回结果。
 */
export function buildPartialCandle(candle, phase) {
  const normalizedPhase = clamp01(phase);
  const { open, high, low, close } = candle;
  const path = close >= open
    ? [open, low, high, close]
    : [open, high, low, close];

  const pathPosition = normalizedPhase * (path.length - 1);
  const segmentIndex = Math.min(Math.floor(pathPosition), path.length - 2);
  const segmentPhase = pathPosition - segmentIndex;
  const currentPrice = interpolate(
    path[segmentIndex],
    path[segmentIndex + 1],
    segmentPhase,
  );
  const visitedPrices = [...path.slice(0, segmentIndex + 1), currentPrice];

  return {
    ...candle,
    open,
    high: Math.max(...visitedPrices),
    low: Math.min(...visitedPrices),
    close: currentPrice,
  };
}

/** 当前 K 线成交量只按已回放进度显示，避免提前暴露整根 K 线的最终成交量。 */
export function getReplayVolume(volume, phase) {
  const normalizedVolume = Number(volume);
  if (!Number.isFinite(normalizedVolume) || normalizedVolume <= 0) return 0;
  return normalizedVolume * clamp01(phase);
}

/** 截取当前回放时刻之前已经发布的历史 OI 数据。 */
export function getReplayOpenInterestPoints(points, replayTimeMs) {
  if (!Array.isArray(points) || !Number.isFinite(Number(replayTimeMs))) return [];
  const cutoffSeconds = Number(replayTimeMs) / 1000;
  return points.filter((point) => Number.isFinite(point?.time) && point.time <= cutoffSeconds);
}

/**
 * 计算某个回放时刻的实际剩余仓位、历史峰值仓位，以及用于分色显示的入场来源段。
 *
 * - 新记录优先使用 entries 保留的基础开仓/加仓逐笔证据。
 * - 旧记录没有 entries 时，把 trade.quantity 视为一笔基础开仓，保持历史兼容。
 * - 平仓无法对应真实交易所“批次”，因此按当前各来源段的数量同比例缩减；
 *   这里只是中性的可视化分配，不代表 FIFO/LIFO 成交归属。
 * - 比例分母使用当前时刻之前出现过的峰值仓位，不读取未来加仓。
 */
export function buildReplayPositionState(trade, replayTimeMs = Number.POSITIVE_INFINITY) {
  const cutoffTimeMs = normalizeReplayCutoffTime(replayTimeMs);
  const entries = normalizeReplayPositionEntries(trade);
  const exits = normalizeReplayPositionExits(trade);
  const events = [
    ...entries.map((entry, index) => ({
      type: "entry",
      timeMs: positionEventTimeMs(entry.entryTime, Number.NEGATIVE_INFINITY),
      order: index,
      entry,
    })),
    ...exits.map((exit, index) => ({
      type: "exit",
      timeMs: positionEventTimeMs(exit.exitTime, Number.POSITIVE_INFINITY),
      order: entries.length + index,
      exit,
    })),
  ].sort((left, right) => left.timeMs - right.timeMs || left.order - right.order);

  let currentQuantity = 0;
  let peakQuantity = 0;
  let hasEntered = false;
  let nextColorIndex = 0;
  const colorIndexBySource = new Map();
  let segments = [];

  for (const event of events) {
    if (event.timeMs > cutoffTimeMs) break;

    if (event.type === "entry") {
      const entry = event.entry;
      const sourceKey = entry.sourceOrderId ?? entry.id;
      let colorIndex = colorIndexBySource.get(sourceKey);
      if (colorIndex === undefined) {
        colorIndex = nextColorIndex;
        colorIndexBySource.set(sourceKey, colorIndex);
        nextColorIndex += 1;
      }

      hasEntered = true;
      currentQuantity = cleanPositionNumber(currentQuantity + entry.quantity);
      peakQuantity = cleanPositionNumber(Math.max(peakQuantity, currentQuantity));
      segments.push({
        id: entry.id,
        sourceOrderId: entry.sourceOrderId,
        entryTime: entry.entryTime,
        entryPrice: entry.entryPrice,
        initialQuantity: entry.quantity,
        remainingQuantity: entry.quantity,
        colorIndex,
        isAddition: colorIndex > 0,
      });
      continue;
    }

    if (currentQuantity <= POSITION_QUANTITY_EPSILON) continue;
    const closedQuantity = Math.min(event.exit.quantity, currentQuantity);
    const remainingFactor = Math.max(
      0,
      (currentQuantity - closedQuantity) / currentQuantity,
    );
    segments = segments
      .map((segment) => ({
        ...segment,
        remainingQuantity: cleanPositionNumber(
          segment.remainingQuantity * remainingFactor,
        ),
      }))
      .filter((segment) => segment.remainingQuantity > POSITION_QUANTITY_EPSILON);
    currentQuantity = cleanPositionNumber(currentQuantity - closedQuantity);
  }

  if (currentQuantity <= POSITION_QUANTITY_EPSILON) {
    currentQuantity = 0;
    segments = [];
  }
  const ratio = peakQuantity > POSITION_QUANTITY_EPSILON
    ? clamp01(currentQuantity / peakQuantity)
    : 0;

  return {
    hasEntered,
    isClosed: hasEntered && currentQuantity === 0,
    currentQuantity,
    peakQuantity,
    ratio,
    label: formatPositionRatioLabel(ratio),
    segments: segments.map((segment) => ({
      ...segment,
      ratio: peakQuantity > POSITION_QUANTITY_EPSILON
        ? clamp01(segment.remainingQuantity / peakQuantity)
        : 0,
      shareOfCurrent: currentQuantity > POSITION_QUANTITY_EPSILON
        ? clamp01(segment.remainingQuantity / currentQuantity)
        : 0,
    })),
  };
}

/**
 * 构造截至当前回放时刻的逐笔成交快照。
 *
 * 与聚合后的 trade.entryPrice 不同，这里严格按开仓、加仓和平仓的实际时间
 * 推进成本与盈亏，避免在加仓发生前提前使用最终加权成本和最终总数量。
 */
export function buildReplayTradeSnapshot(
  trade,
  replayTimeMs = Number.POSITIVE_INFINITY,
  currentPrice,
) {
  if (!trade || typeof trade !== "object") {
    throw new TypeError("交易必须是对象");
  }

  const cutoffTimeMs = normalizeReplayCutoffTime(replayTimeMs);
  const entries = normalizeReplayPositionEntries(trade);
  const exits = normalizeReplayPositionExits(trade);
  const fundingFees = normalizeReplayFundingFees(trade);
  const hasFundingFees = Array.isArray(trade.fundingFees);
  const direction = trade.side === "short" ? -1 : 1;
  const entrySide = direction === 1 ? "buy" : "sell";
  const exitSide = direction === 1 ? "sell" : "buy";
  const timeline = [
    ...entries.map((entry, index) => ({
      type: "entry",
      timeMs: positionEventTimeMs(entry.entryTime, Number.NEGATIVE_INFINITY),
      priority: 0,
      order: index,
      entry,
    })),
    ...fundingFees.map((fundingFee, index) => ({
      type: "funding",
      timeMs: positionEventTimeMs(fundingFee.time, Number.POSITIVE_INFINITY),
      priority: 1,
      order: index,
      fundingFee,
    })),
    ...exits.map((exit, index) => ({
      type: "exit",
      timeMs: positionEventTimeMs(exit.exitTime, Number.POSITIVE_INFINITY),
      priority: 2,
      order: index,
      exit,
    })),
  ].sort(
    (left, right) =>
      left.timeMs - right.timeMs ||
      left.priority - right.priority ||
      left.order - right.order,
  );

  let currentQuantity = 0;
  let peakQuantity = 0;
  let currentCostNotional = 0;
  let openEntryFees = 0;
  let entryNotional = 0;
  let entryFees = 0;
  let exitFees = 0;
  let accruedFundingFee = 0;
  let exitedQuantity = 0;
  let realizedPnl = 0;
  let averageEntryPrice = null;
  const visibleEntries = [];
  const visibleExits = [];
  const visibleFundingFees = [];
  const events = [];

  for (const item of timeline) {
    if (item.timeMs > cutoffTimeMs) break;

    if (item.type === "entry") {
      const entry = item.entry;
      if (!Number.isFinite(entry.entryPrice) || entry.entryPrice <= 0) continue;
      const isAddition = visibleEntries.length > 0;

      currentCostNotional += entry.entryPrice * entry.quantity;
      currentQuantity += entry.quantity;
      peakQuantity = Math.max(peakQuantity, currentQuantity);
      entryNotional += entry.entryPrice * entry.quantity;
      entryFees += entry.fee;
      openEntryFees += entry.fee;
      averageEntryPrice = currentCostNotional / currentQuantity;
      visibleEntries.push(entry);
      events.push({
        id: `replay-entry-${entry.id}`,
        type: "entry",
        side: entrySide,
        timeMs: item.timeMs,
        price: entry.entryPrice,
        quantity: entry.quantity,
        isAddition,
        sourceOrderId: entry.sourceOrderId,
      });
      continue;
    }

    if (item.type === "funding") {
      if (currentQuantity > POSITION_QUANTITY_EPSILON) {
        accruedFundingFee += item.fundingFee.amount;
        realizedPnl += item.fundingFee.amount;
        visibleFundingFees.push(item.fundingFee);
      }
      continue;
    }

    const exit = item.exit;
    if (
      currentQuantity <= POSITION_QUANTITY_EPSILON ||
      !Number.isFinite(exit.exitPrice) ||
      exit.exitPrice <= 0
    ) {
      continue;
    }

    const quantityBeforeExit = currentQuantity;
    const closedQuantity = Math.min(exit.quantity, quantityBeforeExit);
    const averageBeforeExit = currentCostNotional / quantityBeforeExit;
    const exitRatio = closedQuantity / exit.quantity;
    const appliedExitFee = exit.fee * exitRatio;
    const allocatedEntryFee = openEntryFees * (closedQuantity / quantityBeforeExit);

    realizedPnl +=
      (exit.exitPrice - averageBeforeExit) *
        closedQuantity *
        direction -
      allocatedEntryFee -
      appliedExitFee;
    exitedQuantity += closedQuantity;
    exitFees += appliedExitFee;
    openEntryFees -= allocatedEntryFee;
    currentQuantity -= closedQuantity;
    currentCostNotional = averageBeforeExit * currentQuantity;
    averageEntryPrice = averageBeforeExit;

    const visibleExit = {
      ...exit,
      quantity: closedQuantity,
      fee: appliedExitFee,
    };
    visibleExits.push(visibleExit);
    events.push({
      id: `replay-exit-${item.order}`,
      type: "exit",
      side: exitSide,
      timeMs: item.timeMs,
      price: exit.exitPrice,
      quantity: closedQuantity,
      isAddition: false,
      sourceOrderId: exit.sourceOrderId ?? null,
    });

    if (currentQuantity <= POSITION_QUANTITY_EPSILON) {
      currentQuantity = 0;
      currentCostNotional = 0;
      openEntryFees = 0;
    }
  }

  const averageEntryPriceForPnl = currentQuantity > POSITION_QUANTITY_EPSILON
    ? currentCostNotional / currentQuantity
    : averageEntryPrice;
  currentQuantity = cleanReplayMetric(currentQuantity);
  peakQuantity = cleanReplayMetric(peakQuantity);
  entryNotional = cleanReplayMetric(entryNotional);
  entryFees = cleanReplayMetric(entryFees);
  exitFees = cleanReplayMetric(exitFees);
  accruedFundingFee = cleanReplayMetric(accruedFundingFee);
  exitedQuantity = cleanReplayMetric(exitedQuantity);
  realizedPnl = cleanReplayMetric(realizedPnl);
  averageEntryPrice = averageEntryPrice === null
    ? null
    : cleanReplayMetric(averageEntryPrice);

  let pnl = null;
  if (visibleEntries.length > 0) {
    let unrealizedPnl = 0;
    if (currentQuantity > POSITION_QUANTITY_EPSILON) {
      const normalizedCurrentPrice = Number(currentPrice);
      if (Number.isFinite(normalizedCurrentPrice) && normalizedCurrentPrice > 0) {
        unrealizedPnl =
          (normalizedCurrentPrice - averageEntryPriceForPnl) *
            currentQuantity *
            direction -
          openEntryFees;
      } else {
        return {
          hasEntered: true,
          isClosed: false,
          currentQuantity,
          peakQuantity,
          averageEntryPrice,
          accruedFees: cleanReplayMetric(entryFees + exitFees),
          ...(hasFundingFees ? { accruedFundingFee } : {}),
          visibleEntries,
          visibleExits,
          ...(hasFundingFees ? { visibleFundingFees } : {}),
          events,
          pnl: null,
        };
      }
    }

    unrealizedPnl = cleanReplayMetric(unrealizedPnl);
    const totalPnl = cleanReplayMetric(realizedPnl + unrealizedPnl);
    const returnRate = entryNotional > POSITION_QUANTITY_EPSILON
      ? cleanReplayMetric(totalPnl / entryNotional)
      : 0;
    pnl = {
      entryNotional,
      exitedQuantity,
      remainingQuantity: currentQuantity,
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      returnRate,
      returnRatePercent: cleanReplayMetric(returnRate * 100),
      entryFees,
      exitFees,
      totalFees: cleanReplayMetric(entryFees + exitFees),
      ...(hasFundingFees ? { fundingFee: accruedFundingFee } : {}),
    };
  }

  return {
    hasEntered: visibleEntries.length > 0,
    isClosed: visibleEntries.length > 0 && currentQuantity === 0,
    currentQuantity,
    peakQuantity,
    averageEntryPrice,
    accruedFees: cleanReplayMetric(entryFees + exitFees),
    ...(hasFundingFees ? { accruedFundingFee } : {}),
    visibleEntries,
    visibleExits,
    ...(hasFundingFees ? { visibleFundingFees } : {}),
    events,
    pnl,
  };
}

/** 简单分数优先显示为 1/2、2/3 等，其余比例显示为整数百分比。 */
export function formatPositionRatioLabel(ratio) {
  const normalizedRatio = clamp01(Number(ratio));
  if (normalizedRatio <= POSITION_QUANTITY_EPSILON) return "0";
  if (1 - normalizedRatio <= POSITION_QUANTITY_EPSILON) return "1";

  for (let denominator = 2; denominator <= 8; denominator += 1) {
    const numerator = Math.round(normalizedRatio * denominator);
    if (numerator <= 0 || numerator >= denominator) continue;
    if (Math.abs(normalizedRatio - numerator / denominator) > 1e-8) continue;
    const divisor = greatestCommonDivisor(numerator, denominator);
    return `${numerator / divisor}/${denominator / divisor}`;
  }

  return `${Math.round(normalizedRatio * 100)}%`;
}

/**
 * 将单根 K 线内部进度映射为毫秒时间戳，让成交与标记在对应时刻出现。
 * 优先使用交易所返回的 closeTime；缺失时使用下一根 K 线开盘前 1 毫秒。
 */
export function getReplayTimeMs(candle, phase, nextCandle) {
  const openTime = Number(candle?.time) * 1000;
  if (!Number.isFinite(openTime)) return 0;
  const closeTime = resolveCloseTimeMs(candle, nextCandle, openTime);

  return Math.round(interpolate(openTime, closeTime, clamp01(phase)));
}

/** 将实际时间定位到一根 K 线的内部进度，入场回放不会从买入前开始。 */
export function getCandlePhaseAtTime(candle, timeMs, nextCandle) {
  const openTime = Number(candle?.time) * 1000;
  if (!Number.isFinite(openTime)) return 0;
  const closeTime = resolveCloseTimeMs(candle, nextCandle, openTime);
  if (closeTime <= openTime) return 0;
  return clamp01((Number(timeMs) - openTime) / (closeTime - openTime));
}

/**
 * 将绝对回放时间映射到另一时间周期的 K 线游标和柱内进度。
 * 用于切换周期时保持同一历史时刻，而不是重新回到交易入场点。
 */
export function locateReplayFrameAtTime(candles, timeMs, minimumCursor = 0) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { cursor: 0, phase: 0 };
  }

  const lastCursor = candles.length - 1;
  const safeMinimum = clampInteger(minimumCursor, 0, lastCursor);
  const targetMs = Number(timeMs);
  if (!Number.isFinite(targetMs)) {
    return { cursor: safeMinimum, phase: 0 };
  }

  const targetSeconds = Math.floor(targetMs / 1000);
  let low = 0;
  let high = lastCursor;
  let located = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(candles[middle]?.time) <= targetSeconds) {
      located = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const cursor = Math.max(safeMinimum, Math.min(located, lastCursor));
  return {
    cursor,
    phase: getCandlePhaseAtTime(candles[cursor], targetMs, candles[cursor + 1]),
  };
}

/**
 * 将图表双击的绝对时间定位到对应 K 线的完成状态。
 * 如果目标早于允许回放的起点，则保留起点 K 线的实际入场进度。
 */
export function locateReplayCandleAtTime(
  candles,
  timeMs,
  minimumCursor = 0,
  minimumPhase = 0,
) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { cursor: 0, phase: 0 };
  }

  const safeMinimum = clampInteger(minimumCursor, 0, candles.length - 1);
  const located = locateReplayFrameAtTime(candles, timeMs, safeMinimum);
  return {
    cursor: located.cursor,
    phase: located.cursor === safeMinimum ? clamp01(minimumPhase) : 1,
  };
}

/**
 * 把挂单变动与平仓成交映射到现有回放进度条。
 * Binance 的改单会表现为“撤销旧单 + 创建新单”，同类订单在 5 秒内衔接时合并为一次修改。
 */
export function buildReplayProgressNodes(trade, candles, entryIndex) {
  if (!trade || typeof trade !== "object" || !Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const safeEntryIndex = clampInteger(entryIndex, 0, candles.length - 1);
  const rawEvents = [];
  const riskLevels = Array.isArray(trade.riskLevels)
    ? trade.riskLevels
        .map((level, index) => ({ level, index }))
        .filter(({ level }) => level && typeof level === "object")
        .sort((left, right) => {
          const timeDifference = eventTimeMs(left.level.startTime) - eventTimeMs(right.level.startTime);
          return timeDifference || left.index - right.index;
        })
    : [];
  const replacedRiskIndexes = new Set();
  const previousRiskByKind = new Map();

  for (const item of riskLevels) {
    const { level, index } = item;
    const startTimeMs = eventTimeMs(level.startTime);
    if (!Number.isFinite(startTimeMs)) continue;

    const previous = previousRiskByKind.get(level.kind);
    const previousEndTimeMs = eventTimeMs(previous?.level?.endTime);
    const isModification =
      previous &&
      previous.level.endState !== "filled" &&
      Number.isFinite(previousEndTimeMs) &&
      startTimeMs >= previousEndTimeMs &&
      startTimeMs - previousEndTimeMs <= 5_000;

    if (isModification) {
      replacedRiskIndexes.add(previous.index);
      rawEvents.push({
        timeMs: startTimeMs,
        order: index * 10,
        action: buildRiskAction("risk-modified", level, {
          previousPrice: previous.level.price,
        }),
      });
    } else {
      rawEvents.push({
        timeMs: startTimeMs,
        order: index * 10,
        action: buildRiskAction("risk-created", level),
      });
    }
    previousRiskByKind.set(level.kind, item);
  }

  for (const { level, index } of riskLevels) {
    const endTimeMs = eventTimeMs(level.endTime);
    if (!Number.isFinite(endTimeMs)) continue;
    let type = null;
    if (level.endState === "filled") type = "risk-filled";
    if (level.endState === "cancelled" && !replacedRiskIndexes.has(index)) {
      type = "risk-cancelled";
    }
    if (level.endState === "expired" && !replacedRiskIndexes.has(index)) {
      type = "risk-expired";
    }
    if (!type) continue;
    rawEvents.push({
      timeMs: endTimeMs,
      order: index * 10 + 1,
      action: buildRiskAction(type, level),
    });
  }

  const exits = Array.isArray(trade.exits)
    ? trade.exits
        .map((exit, index) => ({ exit, index, timeMs: eventTimeMs(exit?.exitTime) }))
        .filter(({ exit, timeMs }) =>
          exit && Number.isFinite(timeMs) && Number.isFinite(exit.quantity) && exit.quantity > 0,
        )
        .sort((left, right) => left.timeMs - right.timeMs || left.index - right.index)
    : [];
  const tradeQuantity = Number(trade.quantity);
  let exitedQuantity = 0;
  for (const { exit, index, timeMs } of exits) {
    exitedQuantity += exit.quantity;
    const fullyClosed =
      Number.isFinite(tradeQuantity) &&
      tradeQuantity > 0 &&
      exitedQuantity >= tradeQuantity - 1e-10;
    rawEvents.push({
      timeMs,
      order: 100_000 + index,
      action: {
        type: fullyClosed ? "full-close" : "partial-close",
        quantity: exit.quantity,
        exitPrice: exit.exitPrice,
      },
    });
  }

  rawEvents.sort((left, right) => left.timeMs - right.timeMs || left.order - right.order);
  const groups = [];
  for (const event of rawEvents) {
    const previous = groups.at(-1);
    if (previous && event.timeMs - previous.timeMs <= 1_000) {
      previous.actions.push(event.action);
      continue;
    }
    groups.push({ timeMs: event.timeMs, actions: [event.action] });
  }

  return groups
    .map((group, index) => {
      const location = locateProgressEvent(candles, safeEntryIndex, group.timeMs);
      if (!location) return null;
      return {
        id: `replay-operation-${group.timeMs}-${index}`,
        timeMs: group.timeMs,
        ...location,
        tone: progressNodeTone(group.actions),
        actions: group.actions,
      };
    })
    .filter(Boolean);
}

function buildRiskAction(type, level, extra = {}) {
  return {
    type,
    riskKind: level.kind,
    executionType: level.executionType,
    ...extra,
    price: level.price,
    inferred: Boolean(level.inferred),
  };
}

function locateProgressEvent(candles, entryIndex, timeMs) {
  const firstOpenTime = Number(candles[entryIndex]?.time) * 1000;
  const lastIndex = candles.length - 1;
  const lastCloseTime = getReplayTimeMs(candles[lastIndex], 1, candles[lastIndex + 1]);
  if (!Number.isFinite(firstOpenTime) || timeMs < firstOpenTime || timeMs > lastCloseTime) {
    return null;
  }

  for (let cursor = entryIndex; cursor <= lastIndex; cursor += 1) {
    const closeTime = getReplayTimeMs(candles[cursor], 1, candles[cursor + 1]);
    if (timeMs > closeTime && cursor < lastIndex) continue;
    const phase = getCandlePhaseAtTime(candles[cursor], timeMs, candles[cursor + 1]);
    const replayCandleCount = Math.max(candles.length - entryIndex, 1);
    return {
      cursor,
      phase,
      positionPercent: clamp01((cursor - entryIndex + phase) / replayCandleCount) * 100,
    };
  }
  return null;
}

function progressNodeTone(actions) {
  const filledRisk = actions.find((action) => action.type === "risk-filled");
  if (filledRisk?.riskKind) return filledRisk.riskKind;
  if (actions.some((action) => action.type === "risk-modified")) return "modified";
  if (actions.some((action) => action.type === "risk-cancelled")) return "cancelled";
  if (actions.some((action) => action.type === "risk-expired")) return "expired";
  const createdRisk = actions.find((action) => action.type === "risk-created");
  if (createdRisk?.riskKind) return createdRisk.riskKind;
  return "exit";
}

function eventTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return Number.NaN;
  return Date.parse(value);
}

/**
 * 生成回放行情请求的语义键。
 *
 * 公开带单轮询会重建 trade/exits 对象；只要真正影响行情范围的数据未变化，
 * 键就保持稳定，避免正在播放的游标被行情加载流程重置。
 */
export function buildReplayMarketDataKey(trade, frame) {
  const latestExit = (Array.isArray(trade?.exits) ? trade.exits : [])
    .map((exit) => ({
      timeMs: eventTimeMs(exit?.exitTime),
      exitPrice: Number(exit?.exitPrice),
    }))
    .filter((exit) => Number.isFinite(exit.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs)
    .at(-1);

  return JSON.stringify([
    String(frame ?? ""),
    String(trade?.id ?? ""),
    String(trade?.symbol ?? ""),
    String(trade?.marketDataSource ?? ""),
    eventTimeMs(trade?.entryTime),
    String(trade?.side ?? ""),
    Number(trade?.entryPrice),
    latestExit?.timeMs ?? null,
    Number.isFinite(latestExit?.exitPrice) ? latestExit.exitPrice : null,
  ]);
}

const POSITION_QUANTITY_EPSILON = 1e-10;

function normalizeReplayPositionEntries(trade) {
  const rawEntries = Array.isArray(trade?.entries)
    ? trade.entries
        .map((entry, index) => normalizeReplayPositionEntry(entry, index))
        .filter(Boolean)
    : [];
  if (rawEntries.length > 0) return rawEntries;

  const legacyQuantity = Number(trade?.quantity);
  if (!Number.isFinite(legacyQuantity) || legacyQuantity <= POSITION_QUANTITY_EPSILON) {
    return [];
  }
  const legacyEntryPrice = Number(trade?.entryPrice);
  return [{
    id: "legacy-entry",
    sourceOrderId: null,
    quantity: legacyQuantity,
    entryPrice: Number.isFinite(legacyEntryPrice) && legacyEntryPrice > 0
      ? legacyEntryPrice
      : null,
    entryTime: normalizePositionTimeValue(trade?.entryTime),
    fee: normalizePositionFee(trade?.fee),
  }];
}

function normalizeReplayPositionEntry(entry, index) {
  if (!entry || typeof entry !== "object") return null;
  const quantity = Number(entry.quantity);
  if (!Number.isFinite(quantity) || quantity <= POSITION_QUANTITY_EPSILON) return null;
  const entryPrice = Number(entry.entryPrice);
  const sourceOrderId = normalizeOptionalPositionId(entry.sourceOrderId ?? entry.orderId);
  const id = normalizeOptionalPositionId(entry.id) ?? `entry-${index}`;
  return {
    id,
    sourceOrderId,
    quantity,
    entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null,
    entryTime: normalizePositionTimeValue(entry.entryTime ?? entry.time),
    fee: normalizePositionFee(entry.fee),
  };
}

function normalizeReplayPositionExits(trade) {
  if (Array.isArray(trade?.exits) && trade.exits.length > 0) {
    return trade.exits
      .map((exit, index) => {
        const quantity = Number(exit?.quantity);
        if (!Number.isFinite(quantity) || quantity <= POSITION_QUANTITY_EPSILON) {
          return null;
        }
        const exitPrice = Number(exit.exitPrice ?? exit.price);
        return {
          id: normalizeOptionalPositionId(exit.id) ?? `exit-${index}`,
          sourceOrderId: normalizeOptionalPositionId(exit.sourceOrderId ?? exit.orderId),
          quantity,
          exitPrice: Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : null,
          exitTime: normalizePositionTimeValue(exit.exitTime ?? exit.time),
          fee: normalizePositionFee(exit.fee),
        };
      })
      .filter(Boolean);
  }

  const exitPrice = Number(trade?.exitPrice);
  const quantity = Number(trade?.quantity);
  if (
    !Number.isFinite(exitPrice) ||
    exitPrice <= 0 ||
    !Number.isFinite(quantity) ||
    quantity <= POSITION_QUANTITY_EPSILON
  ) {
    return [];
  }
  return [{
    id: "legacy-exit",
    sourceOrderId: null,
    quantity,
    exitPrice,
    exitTime: normalizePositionTimeValue(trade?.exitTime),
    fee: 0,
  }];
}

function normalizeReplayFundingFees(trade) {
  if (!Array.isArray(trade?.fundingFees)) return [];
  return trade.fundingFees
    .map((fundingFee, index) => {
      if (!fundingFee || typeof fundingFee !== "object") return null;
      const amount = Number(fundingFee.amount);
      const time = normalizePositionTimeValue(fundingFee.time);
      if (!Number.isFinite(amount) || time === null || !Number.isFinite(Date.parse(time))) {
        return null;
      }
      return {
        ...fundingFee,
        transactionId: normalizeOptionalPositionId(
          fundingFee.transactionId ?? fundingFee.tranId,
        ) ?? `funding-${index}`,
        amount,
        time,
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time) ||
      left.transactionId.localeCompare(right.transactionId));
}

function normalizeReplayCutoffTime(value) {
  if (value === Number.POSITIVE_INFINITY || value === undefined || value === null) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = positionEventTimeMs(value, Number.NEGATIVE_INFINITY);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function positionEventTimeMs(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePositionTimeValue(value) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function normalizeOptionalPositionId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizePositionFee(value) {
  const fee = Number(value);
  return Number.isFinite(fee) && fee >= 0 ? fee : 0;
}

function cleanPositionNumber(value) {
  if (!Number.isFinite(value) || Math.abs(value) <= POSITION_QUANTITY_EPSILON) return 0;
  return Number(value.toPrecision(15));
}

function cleanReplayMetric(value) {
  if (!Number.isFinite(value) || Math.abs(value) <= POSITION_QUANTITY_EPSILON) return 0;
  return Number(value.toFixed(10));
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

/**
 * 推进一个回放渲染帧。
 *
 * 当前 K 线会先逐步走到 phase=1；只有下一次调用才进入下一根，
 * 因而完整蜡烛一定至少渲染一帧。最后一根完成后保持在终态。
 */
export function advanceReplayFrame(state, candleCount, phaseStep) {
  const normalizedCount = normalizeCount(candleCount);
  if (normalizedCount === 0) {
    return { cursor: 0, phase: 0, finished: true };
  }

  const lastCursor = normalizedCount - 1;
  const cursor = clampInteger(state?.cursor, 0, lastCursor);
  const phase = clamp01(state?.phase);
  const step = clamp01(phaseStep);

  if (phase === 1) {
    if (cursor === lastCursor) {
      return { cursor, phase: 1, finished: true };
    }
    return { cursor: cursor + 1, phase: 0, finished: false };
  }

  const nextPhase = Math.min(1, phase + step);
  return {
    cursor,
    phase: nextPhase,
    finished: cursor === lastCursor && nextPhase === 1,
  };
}

function interpolate(start, end, phase) {
  if (phase <= 0) return start;
  if (phase >= 1) return end;
  return start + (end - start) * phase;
}

function resolveCloseTimeMs(candle, nextCandle, openTime) {
  const explicitCloseTime = Number(candle?.closeTime);
  const nextOpenTime = Number(nextCandle?.time) * 1000;
  if (Number.isFinite(explicitCloseTime) && explicitCloseTime >= openTime) {
    return explicitCloseTime;
  }
  if (Number.isFinite(nextOpenTime) && nextOpenTime > openTime) {
    return nextOpenTime - 1;
  }
  return openTime;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeCount(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function clampInteger(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
