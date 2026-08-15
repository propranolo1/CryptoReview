/**
 * 根据回放时刻计算当前应显示的成本、止盈与止损价格线。
 * 动态风险记录存在时视为权威历史；没有该字段时才兼容旧版静态 TP/SL。
 */
export function getReplayPriceLines(trade, replayTimeMs) {
  const entryPrice = positiveNumber(trade?.entryPrice, "成本价");
  const lines = [
    { id: "cost", kind: "cost", price: entryPrice, label: "成本" },
  ];

  if (Array.isArray(trade?.riskLevels)) {
    for (const level of trade.riskLevels) {
      if (getRiskLevelReplayState(level, replayTimeMs) !== "active") continue;
      const kind = normalizeKind(level?.kind);
      lines.push({
        id: String(level.id),
        kind,
        price: positiveNumber(level.price, "挂单价格"),
        label: riskLineLabel(kind, level.executionType),
        ...(typeof level.inferred === "boolean"
          ? { inferred: level.inferred }
          : {}),
      });
    }
    return lines;
  }

  if (isPositiveNumber(trade?.takeProfit)) {
    lines.push({
      id: "static-take-profit",
      kind: "takeProfit",
      price: Number(trade.takeProfit),
      label: "TP",
    });
  }
  if (isPositiveNumber(trade?.stopLoss)) {
    lines.push({
      id: "static-stop-loss",
      kind: "stopLoss",
      price: Number(trade.stopLoss),
      label: "SL",
    });
  }
  return lines;
}

/** 使用 [开始时间, 结束时间) 边界还原挂单在某个回放时刻的状态。 */
export function getRiskLevelReplayState(level, replayTimeMs) {
  if (!level || typeof level !== "object") {
    throw new TypeError("挂单记录必须是对象");
  }
  const replayTime = finiteNumber(replayTimeMs, "回放时间");
  const startTime = timestamp(level.startTime, "挂单开始时间");
  if (replayTime < startTime) return "pending";

  if (level.endTime !== null && level.endTime !== undefined && level.endTime !== "") {
    const endTime = timestamp(level.endTime, "挂单结束时间");
    if (endTime < startTime) {
      throw new RangeError("挂单结束时间不能早于开始时间");
    }
    if (replayTime >= endTime) {
      return normalizeEndState(level.endState);
    }
  }
  return "active";
}

function normalizeKind(value) {
  if (value === "takeProfit" || value === "stopLoss") return value;
  throw new TypeError("挂单类型必须是 takeProfit 或 stopLoss");
}

function riskLineLabel(kind, executionType) {
  const base = kind === "takeProfit" ? "TP" : "SL";
  if (executionType === "market") return `${base} · MARKET`;
  if (executionType === "limit") return `${base} · LIMIT`;
  return base;
}

function normalizeEndState(value) {
  if (value === "expired" || value === "cancelled" || value === "filled") {
    return value;
  }
  return "ended";
}

function timestamp(value, label) {
  const parsed = typeof value === "number" ? value : new Date(value).getTime();
  return finiteNumber(parsed, label);
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new RangeError(`${label}必须大于 0`);
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}无效`);
  return number;
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}
