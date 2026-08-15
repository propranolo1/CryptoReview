import { hasTrainingTradeActivity } from "./training.mjs";

const MAIN_TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1_000,
  "1H": 60 * 60 * 1_000,
  "4H": 4 * 60 * 60 * 1_000,
  "1D": 24 * 60 * 60 * 1_000,
});

export function calculateTrainingRiskExpectation({
  startingCapital,
  position,
  risk,
}) {
  const capital = positiveNumber(startingCapital, "训练初始资金");
  if (!position) {
    return { takeProfit: null, stopLoss: null, rewardRiskRatio: null };
  }
  const side = normalizeDirection(position.side, "训练仓位方向");
  const quantity = positiveNumber(position.quantity, "训练持仓数量");
  const averagePrice = positiveNumber(position.averagePrice, "训练持仓成本");
  if (!risk) {
    return { takeProfit: null, stopLoss: null, rewardRiskRatio: null };
  }

  const buildExpectation = (priceValue, ratioValue, label) => {
    if (priceValue === null || priceValue === undefined) return null;
    const price = positiveNumber(priceValue, `${label}价格`);
    const positionRatio = boundedRatio(ratioValue ?? 1, `${label}仓位比例`);
    const exitQuantity = quantity * positionRatio;
    const direction = side === "long" ? 1 : -1;
    const pnl = clean((price - averagePrice) * exitQuantity * direction);
    return {
      price,
      positionRatio,
      quantity: clean(exitQuantity),
      pnl,
      returnRatePercent: clean((pnl / capital) * 100),
      distancePercent: clean(((price - averagePrice) / averagePrice) * 100),
    };
  };

  const takeProfit = buildExpectation(
    risk.takeProfit,
    risk.takeProfitRatio,
    "止盈",
  );
  const stopLoss = buildExpectation(
    risk.stopLoss,
    risk.stopLossRatio,
    "止损",
  );
  const rewardRiskRatio = takeProfit && stopLoss && stopLoss.pnl !== 0
    ? clean(Math.abs(takeProfit.pnl / stopLoss.pnl))
    : null;
  return { takeProfit, stopLoss, rewardRiskRatio };
}

export function buildTrainingSessionSummary({
  result,
  candles,
  mainTimeframe,
}) {
  if (!isRecord(result)) {
    throw new TypeError("训练结果必须是对象");
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError("训练总结至少需要一根已揭示 K 线");
  }
  const timeframeMs = MAIN_TIMEFRAME_MS[mainTimeframe];
  if (!timeframeMs) {
    throw new RangeError("训练总结主图周期无效");
  }
  const actions = normalizeActions(result.actions);
  const riskChanges = normalizeRiskChanges(result.riskChanges);
  const netPnl = finiteNumber(result.netPnl, "训练净盈亏");
  const returnRatePercent = finiteNumber(
    result.returnRatePercent,
    "训练收益率",
  );
  const cycles = buildPositionCycles(actions);
  const initialRisk = calculateInitialRisk(cycles, riskChanges);
  const { mfe, mae } = calculateExcursion(actions, candles);
  const holdingDurations = cycles
    .filter((cycle) => cycle.closedAt !== null)
    .map((cycle) => Math.max(0, cycle.closedAt - cycle.openedAt));
  const averageHoldingMs = holdingDurations.length === 0
    ? 0
    : clean(holdingDurations.reduce((sum, value) => sum + value, 0) /
      holdingDurations.length);
  const directions = new Set(cycles.map((cycle) => cycle.direction));
  const direction = directions.size === 0
    ? null
    : directions.size === 1
      ? [...directions][0]
      : "mixed";

  return {
    version: 1,
    netPnl,
    returnRatePercent,
    initialRisk,
    rMultiple: initialRisk === null || initialRisk === 0
      ? null
      : clean(netPnl / initialRisk),
    mfe,
    mae,
    averageHoldingBars: clean(averageHoldingMs / timeframeMs),
    averageHoldingMs,
    holdingCycleCount: holdingDurations.length,
    addCount: actions.filter((action) => action.type === "add").length,
    reduceCount: actions.filter((action) => action.type === "reduce").length,
    direction,
    mainTimeframe,
    excursionBasis: "candle-high-low",
  };
}

export function calculateTrainingAnalyticsPerformance(results) {
  if (!Array.isArray(results)) {
    throw new TypeError("训练分析结果必须是数组");
  }
  const byId = new Map();
  results.forEach((record, index) => {
    if (!isRecord(record)) {
      throw new TypeError(`第 ${index + 1} 条训练分析结果必须是对象`);
    }
    const id = nonEmptyString(record.id, `第 ${index + 1} 条训练 id`);
    const endedAt = Date.parse(String(record.endedAt ?? ""));
    if (!Number.isFinite(endedAt)) {
      throw new RangeError(`第 ${index + 1} 条训练结束时间无效`);
    }
    byId.delete(id);
    byId.set(id, {
      id,
      endedAt,
      netPnl: finiteNumber(record.netPnl, `第 ${index + 1} 条训练净盈亏`),
      summary: normalizeSummary(record.summary),
      hasTradeActivity: hasTrainingTradeActivity(record),
    });
  });
  const entries = [...byId.values()]
    .filter((entry) => entry.hasTradeActivity)
    .sort((left, right) =>
      left.endedAt - right.endedAt || left.id.localeCompare(right.id)
    );
  const rValues = entries
    .map((entry) => entry.summary?.rMultiple)
    .filter(Number.isFinite);
  const holdingValues = entries
    .map((entry) => entry.summary?.averageHoldingMs)
    .filter(Number.isFinite);
  const maeValues = entries
    .map((entry) => entry.summary?.mae)
    .filter(Number.isFinite)
    .map((value) => Math.abs(value));

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let currentWins = 0;
  let currentLosses = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  entries.forEach((entry) => {
    cumulative = clean(cumulative + entry.netPnl);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    if (entry.netPnl > 0) {
      currentWins += 1;
      currentLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
    } else if (entry.netPnl < 0) {
      currentLosses += 1;
      currentWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
  });

  const directionStats = {
    long: aggregateGroup(entries.filter((entry) => entry.summary?.direction === "long")),
    short: aggregateGroup(entries.filter((entry) => entry.summary?.direction === "short")),
  };
  const timeframeStats = Object.fromEntries(
    Object.keys(MAIN_TIMEFRAME_MS).map((timeframe) => [
      timeframe,
      aggregateGroup(entries.filter(
        (entry) => entry.summary?.mainTimeframe === timeframe,
      )),
    ]),
  );

  return {
    averageR: average(rValues),
    rSampleSize: rValues.length,
    maxDrawdown: clean(maxDrawdown),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    averageHoldingMs: average(holdingValues),
    averageMae: average(maeValues),
    directionStats,
    timeframeStats,
  };
}

function buildPositionCycles(actions) {
  const cycles = [];
  let active = null;
  actions.forEach((action) => {
    const locationTime = Number(action.marketLocation?.candleOpenTimeMs);
    if (!Number.isFinite(locationTime)) return;
    if (action.positionBefore === null && action.positionAfter) {
      active = {
        openedAt: locationTime,
        closedAt: null,
        startOperationSequence: action.operationSequence,
        endOperationSequence: Number.POSITIVE_INFINITY,
        direction: normalizeDirection(action.positionAfter.side, "训练持仓方向"),
      };
      cycles.push(active);
    }
    if (active && action.positionAfter === null) {
      active.closedAt = locationTime;
      active.endOperationSequence = action.operationSequence;
      active = null;
    }
  });
  return cycles;
}

function calculateInitialRisk(cycles, riskChanges) {
  if (cycles.length === 0) return null;
  let totalRisk = 0;
  for (const cycle of cycles) {
    const firstStop = riskChanges.find((change) =>
      change.operationSequence > cycle.startOperationSequence &&
      change.operationSequence < cycle.endOperationSequence &&
      change.after?.stopLoss !== null &&
      change.after?.stopLoss !== undefined
    );
    if (!firstStop?.position) return null;
    const stopLoss = positiveNumber(firstStop.after.stopLoss, "训练初始止损");
    const averagePrice = positiveNumber(
      firstStop.position.averagePrice,
      "训练初始风险成本",
    );
    const quantity = positiveNumber(
      firstStop.position.quantity,
      "训练初始风险仓位",
    );
    totalRisk += Math.abs(averagePrice - stopLoss) * quantity;
  }
  return clean(totalRisk);
}

function calculateExcursion(actions, candles) {
  const actionsByIndex = new Map();
  actions.forEach((action) => {
    const index = Number(action.marketLocation?.candleIndex);
    if (!Number.isInteger(index) || index < 0 || index >= candles.length) return;
    const list = actionsByIndex.get(index) ?? [];
    list.push(action);
    actionsByIndex.set(index, list);
  });
  actionsByIndex.forEach((list) => list.sort(
    (left, right) => left.operationSequence - right.operationSequence,
  ));

  let position = null;
  let realizedPnl = 0;
  let mfe = 0;
  let mae = 0;
  candles.forEach((rawCandle, candleIndex) => {
    const candle = normalizeCandle(rawCandle, candleIndex);
    if (position) {
      const favorablePrice = position.side === "long" ? candle.high : candle.low;
      const adversePrice = position.side === "long" ? candle.low : candle.high;
      mfe = Math.max(mfe, realizedPnl + positionPnl(position, favorablePrice));
      mae = Math.min(mae, realizedPnl + positionPnl(position, adversePrice));
    }
    (actionsByIndex.get(candleIndex) ?? []).forEach((action) => {
      realizedPnl = finiteNumber(
        action.totalRealizedPnl ?? realizedPnl,
        "训练累计已实现盈亏",
      );
      position = action.positionAfter ? normalizePosition(action.positionAfter) : null;
      const equityPnl = realizedPnl + finiteNumber(
        action.unrealizedPnlAfter ?? 0,
        "训练操作后未实现盈亏",
      );
      mfe = Math.max(mfe, equityPnl);
      mae = Math.min(mae, equityPnl);
    });
  });
  return { mfe: clean(mfe), mae: clean(mae) };
}

function aggregateGroup(entries) {
  const sessions = entries.length;
  const wins = entries.filter((entry) => entry.netPnl > 0).length;
  const losses = entries.filter((entry) => entry.netPnl < 0).length;
  const rValues = entries
    .map((entry) => entry.summary?.rMultiple)
    .filter(Number.isFinite);
  return {
    sessions,
    wins,
    losses,
    winRate: sessions === 0 ? 0 : clean((wins / sessions) * 100),
    totalPnl: clean(entries.reduce((sum, entry) => sum + entry.netPnl, 0)),
    averageR: average(rValues),
  };
}

function normalizeActions(value) {
  if (!Array.isArray(value)) throw new TypeError("训练操作记录必须是数组");
  return value.map((action, index) => {
    if (!isRecord(action)) throw new TypeError("训练操作记录必须是对象");
    return {
      ...action,
      operationSequence: positiveNumber(
        action.operationSequence ?? action.sequence ?? index + 1,
        "训练操作顺序",
      ),
      positionBefore: action.positionBefore ? normalizePosition(action.positionBefore) : null,
      positionAfter: action.positionAfter ? normalizePosition(action.positionAfter) : null,
    };
  }).sort((left, right) => left.operationSequence - right.operationSequence);
}

function normalizeRiskChanges(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("训练风控记录必须是数组");
  return value.map((change, index) => {
    if (!isRecord(change)) throw new TypeError("训练风控记录必须是对象");
    return {
      ...change,
      operationSequence: positiveNumber(
        change.operationSequence ?? change.sequence ?? index + 1,
        "训练风控顺序",
      ),
      position: change.position ? normalizePosition(change.position) : null,
    };
  }).sort((left, right) => left.operationSequence - right.operationSequence);
}

function normalizeSummary(value) {
  if (!isRecord(value)) return null;
  const direction = ["long", "short", "mixed"].includes(value.direction)
    ? value.direction
    : null;
  const mainTimeframe = Object.hasOwn(MAIN_TIMEFRAME_MS, value.mainTimeframe)
    ? value.mainTimeframe
    : null;
  return {
    rMultiple: nullableFinite(value.rMultiple),
    mae: nullableFinite(value.mae),
    averageHoldingMs: nullableFinite(value.averageHoldingMs),
    direction,
    mainTimeframe,
  };
}

function normalizePosition(value) {
  return {
    side: normalizeDirection(value.side, "训练持仓方向"),
    quantity: positiveNumber(value.quantity, "训练持仓数量"),
    averagePrice: positiveNumber(value.averagePrice, "训练持仓成本"),
    margin: finiteNumber(value.margin ?? 0, "训练持仓保证金"),
  };
}

function normalizeCandle(value, index) {
  if (!isRecord(value)) throw new TypeError(`第 ${index + 1} 根训练 K 线必须是对象`);
  const open = positiveNumber(value.open, "训练 K 线开盘价");
  const high = positiveNumber(value.high, "训练 K 线最高价");
  const low = positiveNumber(value.low, "训练 K 线最低价");
  const close = positiveNumber(value.close, "训练 K 线收盘价");
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new RangeError("训练 K 线高低价无效");
  }
  return { open, high, low, close };
}

function positionPnl(position, price) {
  const direction = position.side === "long" ? 1 : -1;
  return (price - position.averagePrice) * position.quantity * direction;
}

function average(values) {
  return values.length === 0
    ? null
    : clean(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function nullableFinite(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDirection(value, label) {
  if (value === "long" || value === "short") return value;
  throw new RangeError(`${label}无效`);
}

function boundedRatio(value, label) {
  const number = positiveNumber(value, label);
  if (number > 1) throw new RangeError(`${label}不能大于 1`);
  return number;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}必须是有效数字`);
  return number;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}必须是非空字符串`);
  }
  return value.trim();
}

function clean(value) {
  const normalized = Number(value.toFixed(8));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
