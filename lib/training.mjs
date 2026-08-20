import { buildProfitPercentDistribution } from "./performance.mjs";

const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_STARTING_CAPITAL = 10_000;
const DEFAULT_LEVERAGE = 1;
const QUANTITY_EPSILON = 1e-10;
const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 创建一轮仅使用 BTCUSDT U 本位合约的训练会话。
 * 所有时间均归一化为 ISO 字符串，返回值可直接 JSON 持久化。
 */
export function createTrainingSession(options = {}) {
  if (!isRecord(options)) {
    throw new TypeError("训练配置必须是对象");
  }

  const id = nonEmptyString(options.id, "训练 id");
  const symbol = String(options.symbol ?? DEFAULT_SYMBOL).trim().toUpperCase();
  if (symbol !== DEFAULT_SYMBOL) {
    throw new RangeError("训练模式目前仅支持 BTCUSDT U 本位合约");
  }

  const startingCapital = positiveMoney(
    options.startingCapital ?? DEFAULT_STARTING_CAPITAL,
    "初始资金",
  );
  const leverage = positiveInteger(
    options.leverage ?? DEFAULT_LEVERAGE,
    "杠杆",
  );
  const startedAt = normalizeTime(options.startedAt, "开始时间");

  return {
    id,
    symbol,
    startingCapital,
    leverage,
    startedAt,
    status: "active",
    realizedPnl: 0,
    unrealizedPnl: 0,
    usedMargin: 0,
    availableCapital: startingCapital,
    walletBalance: startingCapital,
    equity: startingCapital,
    markPrice: null,
    position: null,
    risk: null,
    actions: [],
    riskChanges: [],
    limitOrders: [],
    limitOrderChanges: [],
  };
}

/**
 * 当前训练已经没有持仓风险和待成交挂单时，可以保存并开始新一局。
 * 是否走到已加载行情末尾不参与判断，避免主图周期与底层 15m 游标不同步时误锁按钮。
 */
export function canStartNewTrainingRound(session) {
  if (session === null || session === undefined) return true;
  const current = normalizeSession(session);
  return current.position === null && current.limitOrders.length === 0;
}

/**
 * 在指定价格下计算账户快照。
 *
 * 钱包余额 = 初始资金 + 已实现盈亏；
 * 权益 = 钱包余额 + 未实现盈亏；
 * 可用资金 = 权益 - 当前仓位占用保证金。
 */
export function getTrainingAccountSnapshot(session, currentPrice) {
  const normalizedSession = normalizeSession(session);
  const price = snapshotPrice(normalizedSession, currentPrice);
  return accountSnapshot(normalizedSession, price);
}

/**
 * 设置或清除当前训练仓位的止盈/止损。
 * 价格必须位于当前加权成本的正确一侧，避免创建方向相反的风控单。
 */
export function setTrainingRiskLevels(session, options) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  if (session.status === "finished") {
    throw new RangeError("训练已经结束，不能设置止盈止损");
  }
  if (!isRecord(options)) {
    throw new TypeError("止盈止损配置必须是对象");
  }

  const current = normalizeSession(session);
  if (current.position === null) {
    throw new RangeError("当前没有可设置止盈止损的仓位");
  }
  const changesTakeProfit = Object.prototype.hasOwnProperty.call(options, "takeProfit");
  const changesStopLoss = Object.prototype.hasOwnProperty.call(options, "stopLoss");
  const changesTakeProfitRatio = Object.prototype.hasOwnProperty.call(
    options,
    "takeProfitRatio",
  );
  const changesStopLossRatio = Object.prototype.hasOwnProperty.call(
    options,
    "stopLossRatio",
  );
  if (
    !changesTakeProfit &&
    !changesStopLoss &&
    !changesTakeProfitRatio &&
    !changesStopLossRatio
  ) {
    throw new TypeError("止盈和止损至少需要设置或清除一项");
  }

  const time = normalizeTime(options.time, "止盈止损更新时间");
  assertChronologicalTime(current, time);
  const recordedAt = normalizeTime(
    options.recordedAt ?? time,
    "止盈止损现实记录时间",
  );
  const marketLocation = normalizeTrainingMarketLocation(options.marketLocation);
  const source = normalizeRiskChangeSource(options.source);
  const takeProfit = changesTakeProfit
    ? nullableRiskPrice(options.takeProfit, "止盈价格")
    : current.risk?.takeProfit ?? null;
  const stopLoss = changesStopLoss
    ? nullableRiskPrice(options.stopLoss, "止损价格")
    : current.risk?.stopLoss ?? null;
  const takeProfitRatio = takeProfit === null
    ? null
    : changesTakeProfitRatio
      ? boundedRatio(options.takeProfitRatio, "止盈仓位比例")
      : current.risk?.takeProfitRatio ?? 1;
  const stopLossRatio = stopLoss === null
    ? null
    : changesStopLossRatio
      ? boundedRatio(options.stopLossRatio, "止损仓位比例")
      : current.risk?.stopLossRatio ?? 1;
  if (changesTakeProfitRatio && takeProfit === null) {
    throw new RangeError("设置止盈仓位比例前必须先设置止盈价格");
  }
  if (changesStopLossRatio && stopLoss === null) {
    throw new RangeError("设置止损仓位比例前必须先设置止损价格");
  }
  assertTrainingRiskDirection(current.position, takeProfit, stopLoss);
  const takeProfitTrigger = takeProfit === null
    ? null
    : changesTakeProfit
      ? resolveTakeProfitTrigger(
          current.position,
          takeProfit,
          options.currentPrice,
        )
      : current.risk?.takeProfitTrigger ?? null;
  const nextRisk = takeProfit === null && stopLoss === null
    ? null
    : {
        takeProfit,
        stopLoss,
        ...(takeProfitTrigger === null ? {} : { takeProfitTrigger }),
        ...(takeProfitRatio !== null && takeProfitRatio !== 1
          ? { takeProfitRatio }
          : {}),
        ...(stopLossRatio !== null && stopLossRatio !== 1
          ? { stopLossRatio }
          : {}),
        updatedAt: time,
      };
  const sequence = current.riskChanges.length + 1;
  const riskChange = {
    riskChangeId: `${current.id}-risk-${sequence}`,
    sequence,
    operationSequence: nextOperationSequence(current),
    time,
    recordedAt,
    source,
    changed: {
      takeProfit: changesTakeProfit,
      stopLoss: changesStopLoss,
      takeProfitRatio: changesTakeProfitRatio,
      stopLossRatio: changesStopLossRatio,
    },
    ...(marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(marketLocation) }),
    before: cloneRisk(current.risk),
    after: cloneRisk(nextRisk),
    position: clonePosition(current.position),
  };

  return {
    ...current,
    risk: cloneRisk(nextRisk),
    position: clonePosition(current.position),
    actions: current.actions.map(cloneAction),
    riskChanges: [
      ...current.riskChanges.map(cloneRiskChange),
      riskChange,
    ],
    limitOrders: current.limitOrders.map(cloneLimitOrder),
    limitOrderChanges: current.limitOrderChanges.map(cloneLimitOrderChange),
  };
}

/**
 * 创建一笔从下一根 K 线开始生效的训练限价单。
 * 买入限价必须低于当前价格，卖出限价必须高于当前价格。
 */
export function placeTrainingLimitOrder(session, options) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  if (session.status === "finished") {
    throw new RangeError("训练已经结束，不能设置限价单");
  }
  if (!isRecord(options)) {
    throw new TypeError("限价单配置必须是对象");
  }

  const current = normalizeSession(session);
  const side = normalizeLimitSide(options.side);
  const price = positiveNumber(options.price, "限价单价格");
  const currentPrice = positiveNumber(options.currentPrice, "当前价格");
  if (side === "buy" && price >= currentPrice) {
    throw new RangeError("买入限价必须低于当前价格");
  }
  if (side === "sell" && price <= currentPrice) {
    throw new RangeError("卖出限价必须高于当前价格");
  }
  const ratio = boundedRatio(options.ratio, "限价单仓位比例");
  const time = normalizeTime(options.time, "限价单创建时间");
  assertChronologicalTime(current, time);
  const recordedAt = normalizeTime(
    options.recordedAt ?? time,
    "限价单现实记录时间",
  );
  const marketLocation = normalizeTrainingMarketLocation(options.marketLocation);
  const intent = resolveLimitOrderIntent(current.position, side, ratio);
  const sequence = current.limitOrderChanges.length + 1;
  const order = {
    limitOrderId: `${current.id}-limit-${sequence}`,
    side,
    price,
    ratio,
    intent: intent.type,
    positionSide: intent.positionSide,
    createdAt: time,
    ...(marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(marketLocation) }),
  };
  const change = createLimitOrderChange(current, {
    sequence,
    type: "place",
    time,
    recordedAt,
    marketLocation,
    order,
  });

  return {
    ...current,
    position: clonePosition(current.position),
    risk: cloneRisk(current.risk),
    actions: current.actions.map(cloneAction),
    riskChanges: current.riskChanges.map(cloneRiskChange),
    limitOrders: [...current.limitOrders.map(cloneLimitOrder), order],
    limitOrderChanges: [
      ...current.limitOrderChanges.map(cloneLimitOrderChange),
      change,
    ],
  };
}

/** 撤销一笔尚未成交的训练限价单。 */
export function cancelTrainingLimitOrder(session, options) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  if (session.status === "finished") {
    throw new RangeError("训练已经结束，不能撤销限价单");
  }
  if (!isRecord(options)) {
    throw new TypeError("撤销限价单配置必须是对象");
  }

  const current = normalizeSession(session);
  const limitOrderId = nonEmptyString(options.limitOrderId, "限价单 id");
  const order = current.limitOrders.find(
    (item) => item.limitOrderId === limitOrderId,
  );
  if (!order) {
    throw new RangeError("限价单不存在或已经结束");
  }
  const time = normalizeTime(options.time, "限价单撤销时间");
  assertChronologicalTime(current, time);
  const recordedAt = normalizeTime(
    options.recordedAt ?? time,
    "限价单现实记录时间",
  );
  const marketLocation = normalizeTrainingMarketLocation(options.marketLocation);
  const sequence = current.limitOrderChanges.length + 1;
  const change = createLimitOrderChange(current, {
    sequence,
    type: "cancel",
    time,
    recordedAt,
    marketLocation,
    order,
    reason: options.reason ?? "user",
  });

  return {
    ...current,
    position: clonePosition(current.position),
    risk: cloneRisk(current.risk),
    actions: current.actions.map(cloneAction),
    riskChanges: current.riskChanges.map(cloneRiskChange),
    limitOrders: current.limitOrders
      .filter((item) => item.limitOrderId !== limitOrderId)
      .map(cloneLimitOrder),
    limitOrderChanges: [
      ...current.limitOrderChanges.map(cloneLimitOrderChange),
      change,
    ],
  };
}

/**
 * 用“刚刚揭示的下一根 K 线”推进训练账户，并检查 TP/SL。
 *
 * 历史 OHLC 无法知道同一根柱内高低点的真实先后。若 TP 与 SL 同时被触及，
 * 为避免高估训练成绩，统一采用保守顺序：先按止损价成交。
 */
export function processTrainingCandle(session, candle, options = {}) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  if (session.status === "finished") {
    throw new RangeError("训练已经结束，不能继续推进 K 线");
  }
  if (!isRecord(options)) {
    throw new TypeError("训练 K 线推进配置必须是对象");
  }

  const current = normalizeSession(session);
  const normalizedCandle = normalizeTrainingCandle(candle);
  const time = normalizeTime(options.time, "K 线推进时间");
  assertChronologicalTime(current, time);
  const position = current.position;
  const risk = current.risk;

  if (position !== null && risk !== null) {
    const takeProfitTrigger = risk.takeProfitTrigger ?? (
      position.side === "long" ? "above" : "below"
    );
    const takeProfitHit = risk.takeProfit !== null && (
      takeProfitTrigger === "above"
        ? normalizedCandle.high >= risk.takeProfit
        : normalizedCandle.low <= risk.takeProfit
    );
    const stopLossHit = risk.stopLoss !== null && (
      position.side === "long"
        ? normalizedCandle.low <= risk.stopLoss
        : normalizedCandle.high >= risk.stopLoss
    );
    const triggerKind = stopLossHit
      ? "stopLoss"
      : takeProfitHit
        ? "takeProfit"
        : null;

    if (triggerKind !== null) {
      const triggerPrice = triggerKind === "stopLoss"
        ? risk.stopLoss
        : risk.takeProfit;
      const positionRatio = triggerKind === "stopLoss"
        ? risk.stopLossRatio ?? 1
        : risk.takeProfitRatio ?? 1;
      let nextSession = applyTrainingAction(current, {
        type: positionRatio >= 1 ? "close" : "reduce",
        price: triggerPrice,
        time,
        ...(positionRatio >= 1 ? {} : { positionRatio }),
        ...(options.marketLocation === undefined
          ? {}
          : { marketLocation: options.marketLocation }),
        automatic: true,
        trigger: triggerKind,
      });
      const remainingRisk = nextSession.position === null
        ? null
        : {
            takeProfit: triggerKind === "takeProfit"
              ? null
              : risk.takeProfit,
            stopLoss: triggerKind === "stopLoss"
              ? null
              : risk.stopLoss,
            ...(triggerKind !== "takeProfit" &&
            risk.takeProfit !== null &&
            risk.takeProfitTrigger !== undefined
              ? { takeProfitTrigger: risk.takeProfitTrigger }
              : {}),
            ...(triggerKind !== "takeProfit" &&
            risk.takeProfit !== null &&
            (risk.takeProfitRatio ?? 1) !== 1
              ? { takeProfitRatio: risk.takeProfitRatio }
              : {}),
            ...(triggerKind !== "stopLoss" &&
            risk.stopLoss !== null &&
            (risk.stopLossRatio ?? 1) !== 1
              ? { stopLossRatio: risk.stopLossRatio }
              : {}),
            updatedAt: time,
          };
      const normalizedRemainingRisk =
        remainingRisk !== null &&
        remainingRisk.takeProfit === null &&
        remainingRisk.stopLoss === null
          ? null
          : remainingRisk;
      const actions = nextSession.actions.map(cloneAction);
      if (actions.length > 0) {
        actions[actions.length - 1] = {
          ...actions[actions.length - 1],
          riskAfter: cloneRisk(normalizedRemainingRisk),
        };
      }
      nextSession = {
        ...nextSession,
        risk: cloneRisk(normalizedRemainingRisk),
        actions,
      };
      return {
        session: nextSession,
        trigger: {
          kind: triggerKind,
          price: triggerPrice,
          time,
          candleTime: normalizedCandle.time,
          side: position.side,
          ...(positionRatio === 1
            ? {}
            : {
                positionRatio,
                fullyClosed: nextSession.position === null,
              }),
        },
        limitTriggers: [],
      };
    }
  }

  let nextSession = current;
  const limitTriggers = [];
  for (const order of current.limitOrders) {
    const hit = order.side === "buy"
      ? normalizedCandle.low <= order.price
      : normalizedCandle.high >= order.price;
    if (!hit) continue;

    if (!isLimitOrderIntentCompatible(nextSession.position, order)) {
      nextSession = cancelTrainingLimitOrder(nextSession, {
        limitOrderId: order.limitOrderId,
        time,
        recordedAt: time,
        marketLocation: options.marketLocation,
        reason: "position-changed",
      });
      continue;
    }

    const fillPrice = order.side === "buy"
      ? Math.min(order.price, normalizedCandle.open)
      : Math.max(order.price, normalizedCandle.open);
    const action = limitOrderAction(order, fillPrice, time, options.marketLocation);
    nextSession = applyTrainingAction(nextSession, action);
    const sequence = nextSession.limitOrderChanges.length + 1;
    const triggerChange = createLimitOrderChange(nextSession, {
      sequence,
      type: "trigger",
      time,
      recordedAt: time,
      marketLocation: options.marketLocation,
      order,
    });
    nextSession = {
      ...nextSession,
      limitOrders: nextSession.limitOrders
        .filter((item) => item.limitOrderId !== order.limitOrderId)
        .map(cloneLimitOrder),
      limitOrderChanges: [
        ...nextSession.limitOrderChanges.map(cloneLimitOrderChange),
        triggerChange,
      ],
    };
    limitTriggers.push({
      limitOrderId: order.limitOrderId,
      side: order.side,
      price: fillPrice,
      limitPrice: order.price,
      ratio: order.ratio,
      intent: order.intent,
      time,
      candleTime: normalizedCandle.time,
      actionId: nextSession.actions.at(-1)?.actionId,
    });
  }

  const snapshot = accountSnapshot(nextSession, normalizedCandle.close);
  return {
    session: {
      ...nextSession,
      ...snapshot,
      position: clonePosition(nextSession.position),
      risk: cloneRisk(nextSession.risk),
      actions: nextSession.actions.map(cloneAction),
      riskChanges: nextSession.riskChanges.map(cloneRiskChange),
      limitOrders: nextSession.limitOrders.map(cloneLimitOrder),
      limitOrderChanges: nextSession.limitOrderChanges.map(cloneLimitOrderChange),
    },
    trigger: null,
    limitTriggers,
  };
}

/**
 * 执行一次开仓、加仓、部分平仓或全部平仓操作，始终返回新状态。
 *
 * open/add 的规模必须在 margin、quantity、capitalRatio 中三选一；
 * capitalRatio 使用成交价盯市后的可用资金计算。
 * reduce 的规模必须在 quantity、positionRatio 中二选一，且必须保留仓位。
 */
export function applyTrainingAction(session, action) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  if (session.status === "finished") {
    throw new RangeError("训练已经结束，不能继续操作");
  }

  const current = normalizeSession(session);
  if (!isRecord(action)) {
    throw new TypeError("训练操作必须是对象");
  }

  const type = String(action.type ?? "").trim().toLowerCase();
  if (!["open", "add", "reduce", "close"].includes(type)) {
    throw new TypeError("训练操作类型必须是 open、add、reduce 或 close");
  }

  const time = normalizeTime(action.time, "操作时间");
  assertChronologicalTime(current, time);
  const recordedAt = normalizeTime(action.recordedAt ?? time, "现实记录时间");
  const marketLocation = normalizeTrainingMarketLocation(action.marketLocation);
  const price = positiveNumber(action.price, "成交价格");
  const beforePosition = clonePosition(current.position);
  const beforeRisk = cloneRisk(current.risk);
  const beforeSnapshot = accountSnapshot(current, price);

  let side;
  let quantity;
  let margin;
  let capitalRatio = null;
  let positionRatio = null;
  let realizedPnl = 0;
  let nextRealizedPnl = current.realizedPnl;
  let nextPosition;

  if (type === "open") {
    if (current.position !== null) {
      throw new RangeError("已有未平仓仓位，不能再次开仓");
    }
    side = normalizeSide(action.side);
    ({ quantity, margin, capitalRatio } = resolveEntrySize({
      action,
      price,
      leverage: current.leverage,
      availableCapital: beforeSnapshot.availableCapital,
    }));
    nextPosition = {
      side,
      quantity,
      averagePrice: price,
      margin,
    };
  } else if (type === "add") {
    if (current.position === null) {
      throw new RangeError("当前没有可加仓的仓位");
    }
    side = current.position.side;
    ({ quantity, margin, capitalRatio } = resolveEntrySize({
      action,
      price,
      leverage: current.leverage,
      availableCapital: beforeSnapshot.availableCapital,
    }));

    const totalQuantity = cleanQuantity(current.position.quantity + quantity);
    const weightedCost =
      current.position.averagePrice * current.position.quantity +
      price * quantity;
    nextPosition = {
      side,
      quantity: totalQuantity,
      averagePrice: cleanQuantity(weightedCost / totalQuantity),
      margin: cleanMoney(current.position.margin + margin),
    };
  } else {
    if (current.position === null) {
      throw new RangeError("当前没有可平仓的仓位");
    }
    side = current.position.side;

    if (type === "reduce") {
      ({ quantity, positionRatio } = resolveReductionSize(
        action,
        current.position.quantity,
      ));
    } else {
      quantity = current.position.quantity;
      positionRatio = 1;
    }

    realizedPnl = positionPnl({
      side,
      averagePrice: current.position.averagePrice,
      price,
      quantity,
    });
    nextRealizedPnl = cleanMoney(current.realizedPnl + realizedPnl);
    const marginRatio = quantity / current.position.quantity;
    margin = cleanMoney(current.position.margin * marginRatio);
    const remainingQuantity = cleanQuantity(
      current.position.quantity - quantity,
    );

    nextPosition =
      type === "close" || remainingQuantity <= QUANTITY_EPSILON
        ? null
        : {
            ...current.position,
            quantity: remainingQuantity,
            margin: cleanMoney(current.position.margin - margin),
          };
  }

  const actionBase = {
    ...current,
    realizedPnl: nextRealizedPnl,
    position: nextPosition,
    markPrice: price,
  };
  const afterSnapshot = accountSnapshot(actionBase, price);
  const nextRisk = nextPosition === null
    ? null
    : normalizeTrainingRisk(current.risk, nextPosition);
  const sequence = current.actions.length + 1;
  const actionRecord = {
    actionId: `${current.id}-action-${sequence}`,
    sequence,
    operationSequence: nextOperationSequence(current),
    type,
    time,
    recordedAt,
    side,
    price,
    quantity,
    margin,
    capitalRatio,
    positionRatio,
    realizedPnl,
    totalRealizedPnl: nextRealizedPnl,
    positionBefore: beforePosition,
    positionAfter: clonePosition(nextPosition),
    unrealizedPnlAfter: afterSnapshot.unrealizedPnl,
    equityAfter: afterSnapshot.equity,
    availableCapitalAfter: afterSnapshot.availableCapital,
    ...(marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(marketLocation) }),
    riskBefore: beforeRisk,
    riskAfter: cloneRisk(nextRisk),
    ...(action.automatic === true
      ? {
          automatic: true,
          trigger: normalizeTrainingTrigger(action.trigger),
          ...(action.limitOrderId === undefined
            ? {}
            : {
                limitOrderId: nonEmptyString(
                  action.limitOrderId,
                  "限价单 id",
                ),
              }),
        }
      : {}),
  };

  return {
    ...actionBase,
    ...afterSnapshot,
    position: clonePosition(nextPosition),
    risk: cloneRisk(nextRisk),
    actions: [...current.actions.map(cloneAction), actionRecord],
    riskChanges: current.riskChanges.map(cloneRiskChange),
    limitOrders: current.limitOrders.map(cloneLimitOrder),
    limitOrderChanges: current.limitOrderChanges.map(cloneLimitOrderChange),
  };
}

/**
 * 结束一轮训练。有持仓时必须先通过明确的平仓操作退出，禁止结束时隐式成交。
 */
export function finishTrainingSession(session, options = {}) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  if (session.status === "finished") {
    throw new RangeError("训练已经结束");
  }
  if (!isRecord(options)) {
    throw new TypeError("结束训练配置必须是对象");
  }

  const current = normalizeSession(session);
  const endedAt = normalizeTime(options.endedAt, "结束时间");
  assertChronologicalTime(current, endedAt);

  if (current.position !== null) {
    throw new RangeError("仍有未平仓仓位，必须先平仓后才能结束训练");
  }
  if (current.limitOrders.length > 0) {
    throw new RangeError("仍有未成交限价单，必须先撤销全部限价单后才能结束训练");
  }
  if (!isEmpty(options.exitPrice)) {
    positiveNumber(options.exitPrice, "平仓价格");
  }

  const netPnl = cleanMoney(current.realizedPnl);
  const returnRate = cleanRatio(netPnl / current.startingCapital);
  return {
    ...current,
    status: "finished",
    endedAt,
    endingCapital: cleanMoney(current.startingCapital + netPnl),
    netPnl,
    returnRate,
    returnRatePercent: cleanRatio(returnRate * 100),
    actions: current.actions.map(cloneAction),
    riskChanges: current.riskChanges.map(cloneRiskChange),
    limitOrders: current.limitOrders.map(cloneLimitOrder),
    limitOrderChanges: current.limitOrderChanges.map(cloneLimitOrderChange),
  };
}

/** 判断训练结果是否至少真正开过一次仓；零盈亏的完整交易仍算有效交易。 */
export function hasTrainingTradeActivity(result) {
  if (!isRecord(result)) return false;
  if (Array.isArray(result.actions)) {
    return result.actions.some((action) =>
      isRecord(action) && action.type === "open"
    );
  }
  const holdingCycleCount = Number(result.summary?.holdingCycleCount);
  if (Number.isFinite(holdingCycleCount)) return holdingCycleCount > 0;
  return ["long", "short", "mixed"].includes(result.summary?.direction);
}

/** 汇总多轮已结束且发生过交易的训练表现，同一 id 以最后一份结果为准。 */
export function calculateTrainingPerformance(results) {
  if (!Array.isArray(results)) {
    throw new TypeError("训练结果必须是数组");
  }

  const byId = new Map();
  for (const [index, result] of results.entries()) {
    const normalized = normalizeFinishedResult(result, index);
    byId.delete(normalized.id);
    byId.set(normalized.id, {
      ...normalized,
      hasTradeActivity: hasTrainingTradeActivity(result),
    });
  }

  const entries = [...byId.values()]
    .filter((entry) => entry.hasTradeActivity)
    .sort((left, right) => {
      if (left.time !== right.time) return left.time - right.time;
      return compareStrings(left.id, right.id);
    });

  let totalPnl = 0;
  let winPnl = 0;
  let lossPnl = 0;
  let wins = 0;
  let losses = 0;
  let winHoldingTotalMs = 0;
  let lossHoldingTotalMs = 0;
  let winHoldingSamples = 0;
  let lossHoldingSamples = 0;
  const dailyByDate = new Map();
  const cumulativeCurve = [];

  for (const entry of entries) {
    totalPnl = cleanMoney(totalPnl + entry.pnl);
    if (entry.pnl > 0) {
      wins += 1;
      winPnl = cleanMoney(winPnl + entry.pnl);
      if (entry.holdingMs !== null) {
        winHoldingTotalMs += entry.holdingMs;
        winHoldingSamples += 1;
      }
    } else if (entry.pnl < 0) {
      losses += 1;
      lossPnl = cleanMoney(lossPnl + entry.pnl);
      if (entry.holdingMs !== null) {
        lossHoldingTotalMs += entry.holdingMs;
        lossHoldingSamples += 1;
      }
    }

    cumulativeCurve.push({
      sessionId: entry.id,
      date: entry.date,
      time: entry.time,
      pnl: entry.pnl,
      cumulativePnl: totalPnl,
    });

    const daily = dailyByDate.get(entry.date) ?? {
      date: entry.date,
      pnl: 0,
      sessions: 0,
      wins: 0,
      losses: 0,
    };
    daily.pnl = cleanMoney(daily.pnl + entry.pnl);
    daily.sessions += 1;
    if (entry.pnl > 0) daily.wins += 1;
    if (entry.pnl < 0) daily.losses += 1;
    dailyByDate.set(entry.date, daily);
  }

  const totalSessions = entries.length;
  const averageWin = wins === 0 ? 0 : cleanMoney(winPnl / wins);
  const averageLoss = losses === 0 ? 0 : cleanMoney(lossPnl / losses);

  return {
    totalSessions,
    totalPnl,
    wins,
    losses,
    winRate:
      totalSessions === 0
        ? 0
        : cleanRatio((wins / totalSessions) * 100),
    averageWin,
    averageLoss,
    averageProfitLossRatio:
      wins === 0 || losses === 0
        ? null
        : cleanRatio(averageWin / Math.abs(averageLoss)),
    profitPercentDistribution: buildProfitPercentDistribution(
      entries.map((entry) => entry.returnPercent),
    ),
    averageWinHoldingMs: winHoldingSamples === 0
      ? null
      : cleanMoney(winHoldingTotalMs / winHoldingSamples),
    averageLossHoldingMs: lossHoldingSamples === 0
      ? null
      : cleanMoney(lossHoldingTotalMs / lossHoldingSamples),
    winHoldingSamples,
    lossHoldingSamples,
    cumulativeCurve,
    daily: [...dailyByDate.values()].sort((left, right) =>
      compareStrings(left.date, right.date),
    ),
  };
}

function resolveEntrySize({ action, price, leverage, availableCapital }) {
  const provided = ["margin", "quantity", "capitalRatio"].filter(
    (field) => !isEmpty(action[field]),
  );
  if (provided.length !== 1) {
    throw new TypeError(
      "必须且只能提供一种开仓规模：保证金、BTC 数量或资金比例",
    );
  }

  let quantity;
  let margin;
  let capitalRatio = null;
  if (provided[0] === "margin") {
    margin = positiveMoney(action.margin, "保证金");
    quantity = cleanQuantity((margin * leverage) / price);
  } else if (provided[0] === "quantity") {
    quantity = positiveNumber(action.quantity, "BTC 数量");
    margin = cleanMoney((quantity * price) / leverage);
  } else {
    capitalRatio = boundedRatio(action.capitalRatio, "资金比例");
    if (availableCapital <= 0) {
      throw new RangeError("当前没有可用于开仓的资金");
    }
    margin = cleanMoney(availableCapital * capitalRatio);
    quantity = cleanQuantity((margin * leverage) / price);
  }

  if (margin - availableCapital > moneyTolerance(availableCapital)) {
    throw new RangeError("开仓保证金不能超过当前可用资金");
  }
  if (quantity <= 0 || margin <= 0) {
    throw new RangeError("开仓金额和 BTC 数量必须大于 0");
  }
  return { quantity, margin, capitalRatio };
}

function resolveReductionSize(action, positionQuantity) {
  const provided = ["quantity", "positionRatio"].filter(
    (field) => !isEmpty(action[field]),
  );
  if (provided.length !== 1) {
    throw new TypeError("必须且只能提供一种减仓规模：BTC 数量或持仓比例");
  }

  let quantity;
  let positionRatio;
  if (provided[0] === "quantity") {
    quantity = positiveNumber(action.quantity, "减仓 BTC 数量");
    positionRatio = cleanRatio(quantity / positionQuantity);
  } else {
    positionRatio = boundedRatio(action.positionRatio, "持仓比例");
    quantity = cleanQuantity(positionQuantity * positionRatio);
  }

  if (
    quantity >= positionQuantity ||
    positionQuantity - quantity <= QUANTITY_EPSILON
  ) {
    throw new RangeError("部分平仓后必须保留仓位；全部退出请使用全部平仓");
  }
  return { quantity, positionRatio };
}

function normalizeSession(session) {
  if (!isRecord(session)) {
    throw new TypeError("训练会话必须是对象");
  }
  const id = nonEmptyString(session.id, "训练 id");
  const symbol = String(session.symbol ?? "").trim().toUpperCase();
  if (symbol !== DEFAULT_SYMBOL) {
    throw new RangeError("训练模式目前仅支持 BTCUSDT U 本位合约");
  }
  const startingCapital = positiveMoney(session.startingCapital, "初始资金");
  const leverage = positiveInteger(session.leverage, "杠杆");
  const startedAt = normalizeTime(session.startedAt, "开始时间");
  const realizedPnl = finiteMoney(session.realizedPnl, "已实现盈亏");
  const position = normalizePosition(session.position);
  const risk = normalizeTrainingRisk(session.risk, position);
  if (!Array.isArray(session.actions)) {
    throw new TypeError("训练动作记录必须是数组");
  }
  if (
    session.riskChanges !== undefined &&
    !Array.isArray(session.riskChanges)
  ) {
    throw new TypeError("训练止盈止损修改记录必须是数组");
  }
  if (
    session.limitOrders !== undefined &&
    !Array.isArray(session.limitOrders)
  ) {
    throw new TypeError("训练限价单必须是数组");
  }
  if (
    session.limitOrderChanges !== undefined &&
    !Array.isArray(session.limitOrderChanges)
  ) {
    throw new TypeError("训练限价单记录必须是数组");
  }

  return {
    ...session,
    id,
    symbol,
    startingCapital,
    leverage,
    startedAt,
    status: session.status === "finished" ? "finished" : "active",
    realizedPnl,
    position,
    risk,
    actions: session.actions.map(cloneAction),
    riskChanges: (session.riskChanges ?? []).map(cloneRiskChange),
    limitOrders: (session.limitOrders ?? []).map(normalizeLimitOrder),
    limitOrderChanges: (session.limitOrderChanges ?? []).map(
      normalizeLimitOrderChange,
    ),
  };
}

function normalizePosition(position) {
  if (position === null || position === undefined) return null;
  if (!isRecord(position)) {
    throw new TypeError("训练仓位必须是对象");
  }
  return {
    side: normalizeSide(position.side),
    quantity: positiveNumber(position.quantity, "持仓 BTC 数量"),
    averagePrice: positiveNumber(position.averagePrice, "持仓成本价"),
    margin: positiveMoney(position.margin, "持仓保证金"),
  };
}

function normalizeTrainingRisk(risk, position) {
  if (position === null || risk === null || risk === undefined) return null;
  if (!isRecord(risk)) {
    throw new TypeError("训练止盈止损状态必须是对象");
  }
  const takeProfit = nullableRiskPrice(risk.takeProfit, "止盈价格");
  const stopLoss = nullableRiskPrice(risk.stopLoss, "止损价格");
  if (takeProfit === null && stopLoss === null) return null;
  const updatedAt = normalizeTime(risk.updatedAt, "止盈止损更新时间");
  const takeProfitRatio = takeProfit === null
    ? null
    : boundedRatio(risk.takeProfitRatio ?? 1, "止盈仓位比例");
  const stopLossRatio = stopLoss === null
    ? null
    : boundedRatio(risk.stopLossRatio ?? 1, "止损仓位比例");
  const takeProfitTrigger = takeProfit === null
    ? null
    : normalizeRiskTriggerDirection(risk.takeProfitTrigger);
  assertTrainingRiskDirection(position, takeProfit, stopLoss);
  return {
    takeProfit,
    stopLoss,
    ...(takeProfitTrigger === null ? {} : { takeProfitTrigger }),
    ...(takeProfitRatio !== null && takeProfitRatio !== 1
      ? { takeProfitRatio }
      : {}),
    ...(stopLossRatio !== null && stopLossRatio !== 1
      ? { stopLossRatio }
      : {}),
    updatedAt,
  };
}

function resolveTakeProfitTrigger(position, takeProfit, currentPrice) {
  if (currentPrice === null || currentPrice === undefined) return null;
  const marketPrice = positiveNumber(currentPrice, "当前价格");
  if (position.side === "long") {
    return takeProfit < marketPrice ? "below" : "above";
  }
  return takeProfit > marketPrice ? "above" : "below";
}

function normalizeRiskTriggerDirection(value) {
  if (value === null || value === undefined) return null;
  if (value === "above" || value === "below") return value;
  throw new TypeError("止盈触发方向必须是 above 或 below");
}

function assertTrainingRiskDirection(position, takeProfit, stopLoss) {
  const cost = position.averagePrice;
  if (position.side === "long") {
    if (takeProfit !== null && takeProfit <= cost) {
      throw new RangeError("多仓止盈必须高于当前成本");
    }
    if (stopLoss !== null && stopLoss >= cost) {
      throw new RangeError("多仓止损必须低于当前成本");
    }
    return;
  }
  if (takeProfit !== null && takeProfit >= cost) {
    throw new RangeError("空仓止盈必须低于当前成本");
  }
  if (stopLoss !== null && stopLoss <= cost) {
    throw new RangeError("空仓止损必须高于当前成本");
  }
}

function nullableRiskPrice(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return positiveNumber(value, label);
}

function normalizeTrainingTrigger(value) {
  if (
    value === "takeProfit" ||
    value === "stopLoss" ||
    value === "limitOrder"
  ) {
    return value;
  }
  throw new TypeError(
    "自动成交触发类型必须是 takeProfit、stopLoss 或 limitOrder",
  );
}

function normalizeRiskChangeSource(value) {
  if (value === "drag" || value === "input") return value;
  return "unknown";
}

function normalizeTrainingMarketLocation(location) {
  if (location === null || location === undefined) return undefined;
  if (!isRecord(location)) {
    throw new TypeError("训练操作行情位置必须是对象");
  }

  const interval = String(location.interval ?? "").trim();
  if (!["5m", "15m", "1h", "4h"].includes(interval)) {
    throw new RangeError("训练操作行情周期必须是 5m、15m、1h 或 4h");
  }
  const candleOpenTimeMs = positiveInteger(
    location.candleOpenTimeMs,
    "训练 K 线开盘时间",
  );
  const candleCloseTimeMs = positiveInteger(
    location.candleCloseTimeMs,
    "训练 K 线收盘时间",
  );
  if (candleCloseTimeMs < candleOpenTimeMs) {
    throw new RangeError("训练 K 线收盘时间不能早于开盘时间");
  }
  const candleIndex = nonNegativeInteger(
    location.candleIndex,
    "训练 K 线索引",
  );
  const revealedOffset = nonNegativeInteger(
    location.revealedOffset,
    "训练已揭示 K 线位置",
  );
  const open = positiveNumber(location.open, "训练 K 线开盘价");
  const high = positiveNumber(location.high, "训练 K 线最高价");
  const low = positiveNumber(location.low, "训练 K 线最低价");
  const close = positiveNumber(location.close, "训练 K 线收盘价");
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new RangeError("训练 K 线高低价范围无效");
  }
  const timing = String(location.timing ?? "").trim();
  if (timing !== "candle-close" && timing !== "intrabar-unknown") {
    throw new RangeError(
      "训练操作时间精度必须是 candle-close 或 intrabar-unknown",
    );
  }

  return {
    interval,
    candleOpenTimeMs,
    candleCloseTimeMs,
    candleIndex,
    revealedOffset,
    open,
    high,
    low,
    close,
    timing,
  };
}

function normalizeTrainingCandle(candle) {
  if (!isRecord(candle)) {
    throw new TypeError("训练 K 线必须是对象");
  }
  const time = finiteNumber(candle.time, "训练 K 线时间");
  const open = positiveNumber(candle.open, "训练 K 线开盘价");
  const high = positiveNumber(candle.high, "训练 K 线最高价");
  const low = positiveNumber(candle.low, "训练 K 线最低价");
  const close = positiveNumber(candle.close, "训练 K 线收盘价");
  if (time <= 0) {
    throw new RangeError("训练 K 线时间必须大于 0");
  }
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new RangeError("训练 K 线高低价范围无效");
  }
  return { time, open, high, low, close };
}

function normalizeFinishedResult(result, index) {
  const label = `第 ${index + 1} 次训练`;
  if (!isRecord(result)) {
    throw new TypeError(`${label}结果必须是对象`);
  }
  if (result.status !== "finished") {
    throw new RangeError(`${label}尚未结束，不能计入训练表现`);
  }
  const id = nonEmptyString(result.id, `${label} id`);
  const startingCapital = positiveMoney(result.startingCapital, `${label}初始资金`);
  const pnl = finiteMoney(result.netPnl, `${label}净盈亏`);
  const endedAt = normalizeTime(result.endedAt, `${label}结束时间`);
  const time = Date.parse(endedAt);
  return {
    id,
    pnl,
    returnPercent: cleanRatio((pnl / startingCapital) * 100),
    holdingMs: Number.isFinite(Number(result.summary?.averageHoldingMs)) &&
        Number(result.summary?.averageHoldingMs) >= 0
      ? cleanMoney(Number(result.summary.averageHoldingMs))
      : null,
    endedAt,
    time,
    date: new Date(time + UTC_8_OFFSET_MS).toISOString().slice(0, 10),
  };
}

function accountSnapshot(session, price) {
  const walletBalance = cleanMoney(
    session.startingCapital + session.realizedPnl,
  );
  const usedMargin = cleanMoney(session.position?.margin ?? 0);
  const unrealizedPnl =
    session.position === null
      ? 0
      : positionPnl({
          side: session.position.side,
          averagePrice: session.position.averagePrice,
          price,
          quantity: session.position.quantity,
        });
  const equity = cleanMoney(walletBalance + unrealizedPnl);
  const availableCapital = cleanMoney(equity - usedMargin);
  return {
    markPrice: price,
    walletBalance,
    realizedPnl: cleanMoney(session.realizedPnl),
    unrealizedPnl,
    equity,
    usedMargin,
    availableCapital,
  };
}

function snapshotPrice(session, currentPrice) {
  if (!isEmpty(currentPrice)) {
    return positiveNumber(currentPrice, "当前 BTC 价格");
  }
  if (session.position !== null) {
    return positiveNumber(session.markPrice, "当前 BTC 价格");
  }
  return isEmpty(session.markPrice)
    ? null
    : positiveNumber(session.markPrice, "当前 BTC 价格");
}

function positionPnl({ side, averagePrice, price, quantity }) {
  const direction = side === "long" ? 1 : -1;
  return cleanMoney((price - averagePrice) * quantity * direction);
}

function assertChronologicalTime(session, nextTime) {
  const timestamps = [
    Date.parse(session.startedAt),
    ...session.actions.map((action) => Date.parse(action?.time)),
    ...(session.riskChanges ?? []).map((change) => Date.parse(change?.time)),
    ...(session.limitOrderChanges ?? []).map((change) =>
      Date.parse(change?.time)
    ),
    Date.parse(session.risk?.updatedAt ?? ""),
  ].filter(Number.isFinite);
  const latestTimestamp = Math.max(...timestamps);
  if (Date.parse(nextTime) < latestTimestamp) {
    throw new RangeError("操作时间不能早于训练开始时间或上一笔操作时间");
  }
}

function nextOperationSequence(session) {
  return (
    session.actions.length +
    (session.riskChanges?.length ?? 0) +
    (session.limitOrderChanges?.length ?? 0) +
    1
  );
}

function normalizeLimitSide(value) {
  const side = String(value ?? "").trim().toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new TypeError("限价单方向必须是 buy 或 sell");
  }
  return side;
}

function resolveLimitOrderIntent(position, side, ratio) {
  if (position === null) {
    return {
      type: "open",
      positionSide: side === "buy" ? "long" : "short",
    };
  }
  const addsPosition =
    (position.side === "long" && side === "buy") ||
    (position.side === "short" && side === "sell");
  if (addsPosition) {
    return { type: "add", positionSide: position.side };
  }
  return {
    type: ratio >= 1 ? "close" : "reduce",
    positionSide: position.side,
  };
}

function isLimitOrderIntentCompatible(position, order) {
  if (order.intent === "open") return position === null;
  if (position === null || position.side !== order.positionSide) return false;
  if (order.intent === "add") {
    return (
      (position.side === "long" && order.side === "buy") ||
      (position.side === "short" && order.side === "sell")
    );
  }
  return (
    (position.side === "long" && order.side === "sell") ||
    (position.side === "short" && order.side === "buy")
  );
}

function limitOrderAction(order, price, time, marketLocation) {
  const common = {
    type: order.intent,
    price,
    time,
    recordedAt: time,
    automatic: true,
    trigger: "limitOrder",
    limitOrderId: order.limitOrderId,
    ...(marketLocation === undefined ? {} : { marketLocation }),
  };
  if (order.intent === "open") {
    return {
      ...common,
      side: order.positionSide,
      capitalRatio: order.ratio,
    };
  }
  if (order.intent === "add") {
    return { ...common, capitalRatio: order.ratio };
  }
  if (order.intent === "reduce") {
    return { ...common, positionRatio: order.ratio };
  }
  return common;
}

function normalizeLimitOrder(order) {
  if (!isRecord(order)) {
    throw new TypeError("训练限价单必须是对象");
  }
  const limitOrderId = nonEmptyString(order.limitOrderId, "限价单 id");
  const side = normalizeLimitSide(order.side);
  const price = positiveNumber(order.price, "限价单价格");
  const ratio = boundedRatio(order.ratio, "限价单仓位比例");
  const intent = String(order.intent ?? "").trim();
  if (!["open", "add", "reduce", "close"].includes(intent)) {
    throw new TypeError("限价单意图无效");
  }
  const positionSide = normalizeSide(order.positionSide);
  const createdAt = normalizeTime(order.createdAt, "限价单创建时间");
  const marketLocation = normalizeTrainingMarketLocation(order.marketLocation);
  return {
    limitOrderId,
    side,
    price,
    ratio,
    intent,
    positionSide,
    createdAt,
    ...(marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(marketLocation) }),
  };
}

function normalizeLimitOrderChange(change) {
  if (!isRecord(change)) {
    throw new TypeError("训练限价单记录必须是对象");
  }
  const type = String(change.type ?? "").trim();
  if (!["place", "cancel", "trigger"].includes(type)) {
    throw new TypeError("训练限价单记录类型无效");
  }
  return {
    ...change,
    limitOrderChangeId: nonEmptyString(
      change.limitOrderChangeId,
      "限价单记录 id",
    ),
    sequence: positiveInteger(change.sequence, "限价单记录序号"),
    operationSequence: positiveInteger(
      change.operationSequence ?? change.sequence,
      "训练操作总序号",
    ),
    type,
    time: normalizeTime(change.time, "限价单记录时间"),
    recordedAt: normalizeTime(
      change.recordedAt ?? change.time,
      "限价单现实记录时间",
    ),
    order: normalizeLimitOrder(change.order),
    ...(change.marketLocation === undefined
      ? {}
      : {
          marketLocation: cloneMarketLocation(
            normalizeTrainingMarketLocation(change.marketLocation),
          ),
        }),
  };
}

function createLimitOrderChange(session, options) {
  return {
    limitOrderChangeId: `${session.id}-limit-change-${options.sequence}`,
    sequence: options.sequence,
    operationSequence: nextOperationSequence(session),
    type: options.type,
    time: options.time,
    recordedAt: options.recordedAt,
    order: cloneLimitOrder(options.order),
    ...(options.marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(options.marketLocation) }),
    ...(options.reason === undefined
      ? {}
      : { reason: String(options.reason) }),
  };
}

function normalizeSide(value) {
  const side = String(value ?? "").trim().toLowerCase();
  if (side !== "long" && side !== "short") {
    throw new TypeError("仓位方向必须是 long 或 short");
  }
  return side;
}

function normalizeTime(value, label) {
  let time;
  if (value instanceof Date) {
    time = value.getTime();
  } else if (typeof value === "number") {
    time = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    time = Date.parse(value.trim());
  } else {
    time = Number.NaN;
  }
  if (!Number.isFinite(time)) {
    throw new TypeError(`${label}无效`);
  }
  return new Date(time).toISOString();
}

function positiveInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number <= 0) {
    throw new RangeError(`${label}必须是正整数`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${label}必须是非负整数`);
  }
  return number;
}

function boundedRatio(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0 || number > 1) {
    throw new RangeError(`${label}必须大于 0 且不超过 1`);
  }
  return cleanRatio(number);
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return cleanQuantity(number);
}

function positiveMoney(value, label) {
  const number = finiteMoney(value, label);
  if (number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return number;
}

function finiteMoney(value, label) {
  return cleanMoney(finiteNumber(value, label));
}

function finiteNumber(value, label) {
  if (isEmpty(value)) {
    throw new TypeError(`${label}不能为空`);
  }
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label}必须是有限数字`);
  }
  return number;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}不能为空`);
  }
  return value.trim();
}

function moneyTolerance(value) {
  return Math.max(1, Math.abs(value)) * 1e-10;
}

function cleanMoney(value) {
  return cleanRounded(value, 8);
}

function cleanQuantity(value) {
  return cleanRounded(value, 12);
}

function cleanRatio(value) {
  return cleanRounded(value, 12);
}

function cleanRounded(value, digits) {
  const cleaned = Number(value.toFixed(digits));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}

function clonePosition(position) {
  return position === null ? null : { ...position };
}

function cloneRisk(risk) {
  return risk === null ? null : { ...risk };
}

function cloneAction(action) {
  if (!isRecord(action)) return action;
  return {
    ...action,
    recordedAt: action.recordedAt ?? action.time,
    ...(action.marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(action.marketLocation) }),
    positionBefore: clonePosition(action.positionBefore ?? null),
    positionAfter: clonePosition(action.positionAfter ?? null),
    ...(Object.prototype.hasOwnProperty.call(action, "riskBefore")
      ? { riskBefore: cloneRisk(action.riskBefore ?? null) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(action, "riskAfter")
      ? { riskAfter: cloneRisk(action.riskAfter ?? null) }
      : {}),
  };
}

function cloneRiskChange(change) {
  if (!isRecord(change)) return change;
  return {
    ...change,
    recordedAt: change.recordedAt ?? change.time,
    ...(change.marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(change.marketLocation) }),
    before: cloneRisk(change.before ?? null),
    after: cloneRisk(change.after ?? null),
    position: clonePosition(change.position ?? null),
    changed: isRecord(change.changed) ? { ...change.changed } : change.changed,
  };
}

function cloneLimitOrder(order) {
  if (!isRecord(order)) return order;
  return {
    ...order,
    ...(order.marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(order.marketLocation) }),
  };
}

function cloneLimitOrderChange(change) {
  if (!isRecord(change)) return change;
  return {
    ...change,
    recordedAt: change.recordedAt ?? change.time,
    order: cloneLimitOrder(change.order),
    ...(change.marketLocation === undefined
      ? {}
      : { marketLocation: cloneMarketLocation(change.marketLocation) }),
  };
}

function cloneMarketLocation(location) {
  return isRecord(location) ? { ...location } : location;
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
