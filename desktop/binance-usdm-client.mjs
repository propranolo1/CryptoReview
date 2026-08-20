import { createHmac } from "node:crypto";

const BINANCE_FUTURES_ORIGIN = "https://fapi.binance.com";
const QUERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 1;
const MAX_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const HISTORY_RESULT_LIMIT = 1000;
const MAX_HISTORY_REQUESTS_PER_WINDOW = 4096;
const MAX_INCOME_PAGES = 4096;
const MAX_RATE_LIMIT_RETRIES = 3;
const HISTORY_CONCURRENCY = 4;
const REQUEST_WEIGHT_BUDGET = 2200;
const REQUEST_WEIGHT_INTERVAL_MS = 60_000;

/** 按 Binance Futures USER_DATA 规则计算 HMAC-SHA256 查询签名。 */
export function signBinanceQuery(query, apiSecret) {
  if (typeof query !== "string" || typeof apiSecret !== "string" || apiSecret.length === 0) {
    throw new TypeError("Binance 签名参数无效");
  }
  return createHmac("sha256", apiSecret).update(query).digest("hex");
}

/** 将 Binance 普通委托转换为项目已有的 U 本位订单结构。 */
export function normalizeNormalOrder(raw, accountId) {
  validateRawOrder(raw, "基础委托");
  const symbol = normalizeSymbol(raw.symbol);
  const side = normalizeSide(raw.side);
  const orderId = requiredIdentifier(raw.orderId, "基础委托 orderId");
  const orderType = requiredUpperText(raw.origType ?? raw.type, "基础委托类型");
  const originalQuantity = nonNegativeNumber(raw.origQty, "基础委托数量");
  const executedQuantity = nonNegativeNumber(raw.executedQty ?? 0, "基础委托成交数量");
  const executedQuoteQuantity = nonNegativeNumber(raw.cumQuote ?? 0, "基础委托成交额");
  const createdAt = timestampToIso(raw.time, "基础委托创建时间");
  const updatedAt = timestampToIso(raw.updateTime ?? raw.time, "基础委托更新时间");

  return {
    userId: requiredIdentifier(accountId, "本地账户标识"),
    orderId,
    symbol,
    orderType,
    side,
    limitPrice: positiveNumberOrNull(raw.price),
    averagePrice: positiveNumberOrNull(raw.avgPrice),
    originalQuantity,
    executedQuantity,
    executedQuoteQuantity,
    stopPrice: positiveNumberOrNull(raw.stopPrice),
    status: requiredUpperText(raw.status, "基础委托状态"),
    createdAt,
    updatedAt,
    positionSide: optionalUpperText(raw.positionSide) ?? "BOTH",
    reduceOnly: Boolean(raw.reduceOnly),
    closePosition: Boolean(raw.closePosition),
    workingType: optionalUpperText(raw.workingType),
    sourceKind: "api-normal",
  };
}

/** 将 Binance 逐笔成交转换为可挂接到基础委托的真实成交与手续费证据。 */
export function normalizeUserTrade(raw, accountId) {
  validateRawOrder(raw, "逐笔成交");
  return {
    userId: requiredIdentifier(accountId, "本地账户标识"),
    tradeId: requiredIdentifier(raw.id, "逐笔成交 id"),
    orderId: requiredIdentifier(raw.orderId, "逐笔成交 orderId"),
    symbol: normalizeSymbol(raw.symbol),
    side: normalizeSide(raw.side),
    positionSide: normalizePositionSide(raw.positionSide),
    price: positiveNumber(raw.price, "逐笔成交价格"),
    quantity: positiveNumber(raw.qty, "逐笔成交数量"),
    quoteQuantity: nonNegativeNumber(raw.quoteQty, "逐笔成交额"),
    // commission 可能因返佣为负数，必须原样保留，不能取绝对值或套用固定费率。
    commission: finiteNumber(raw.commission, "逐笔成交手续费"),
    commissionAsset: requiredUpperText(raw.commissionAsset, "逐笔成交手续费资产"),
    realizedPnl: finiteNumber(raw.realizedPnl, "逐笔成交已实现盈亏"),
    time: timestampToIso(raw.time, "逐笔成交时间"),
    maker: Boolean(raw.maker),
  };
}

/** 将收益流水中的 FUNDING_FEE 转换为可按时间回放的真实资金费现金流。 */
export function normalizeFundingFee(raw, accountId) {
  validateRawOrder(raw, "资金费流水");
  if (requiredUpperText(raw.incomeType, "资金费流水类型") !== "FUNDING_FEE") {
    throw new TypeError("资金费流水类型必须是 FUNDING_FEE");
  }
  return {
    userId: requiredIdentifier(accountId, "本地账户标识"),
    transactionId: requiredIdentifier(raw.tranId, "资金费流水 tranId"),
    symbol: normalizeSymbol(raw.symbol),
    incomeType: "FUNDING_FEE",
    amount: finiteNumber(raw.income, "资金费金额"),
    asset: requiredUpperText(raw.asset, "资金费资产"),
    time: timestampToIso(raw.time, "资金费发生时间"),
  };
}

/** 将 Position Information V3 返回值转换为当前未平仓快照。零仓位不写入。 */
export function normalizeOpenPosition(raw, accountId) {
  validateRawOrder(raw, "当前持仓");
  const signedQuantity = finiteNumber(raw.positionAmt, "当前持仓数量");
  if (signedQuantity === 0) return null;

  const positionSide = normalizePositionSide(raw.positionSide);
  const side = positionSide === "LONG"
    ? "long"
    : positionSide === "SHORT"
      ? "short"
      : signedQuantity > 0
        ? "long"
        : "short";

  return {
    userId: requiredIdentifier(accountId, "本地账户标识"),
    symbol: normalizeSymbol(raw.symbol),
    positionSide,
    side,
    quantity: Math.abs(signedQuantity),
    entryPrice: positiveNumber(raw.entryPrice, "当前持仓开仓均价"),
    breakEvenPrice: positiveNumberOrNull(raw.breakEvenPrice),
    markPrice: positiveNumber(raw.markPrice, "当前持仓标记价格"),
    unRealizedProfit: finiteNumber(raw.unRealizedProfit, "当前持仓未实现盈亏"),
    marginAsset: requiredUpperText(raw.marginAsset, "当前持仓保证金资产"),
    // Binance 没有在该响应中提供开仓时间；这里只保存快照更新时间，不能伪造成 entryTime。
    updateTime: timestampToIso(raw.updateTime, "当前持仓更新时间"),
  };
}

/** 将新版 Algo 条件单转换为 TP/SL 风险线可复用的订单结构。 */
export function normalizeAlgoOrder(raw, accountId) {
  validateRawOrder(raw, "Algo 条件单");
  const symbol = normalizeSymbol(raw.symbol);
  const side = normalizeSide(raw.side);
  const algoId = requiredIdentifier(raw.algoId, "Algo 条件单 algoId");
  const orderType = requiredUpperText(raw.orderType, "Algo 条件单类型");
  const rawStatus = requiredUpperText(raw.algoStatus, "Algo 条件单状态");
  const status = rawStatus === "TRIGGERED" || rawStatus === "FINISHED"
    ? "FILLED"
    : rawStatus;
  const createdAt = timestampToIso(raw.createTime, "Algo 条件单创建时间");
  const lifecycleTime = Number(raw.triggerTime) > 0 ? raw.triggerTime : raw.updateTime ?? raw.createTime;
  const triggerPrice = positiveNumberOrNull(raw.triggerPrice) ??
    (orderType.includes("TAKE_PROFIT")
      ? positiveNumberOrNull(raw.tpTriggerPrice)
      : orderType.includes("STOP")
        ? positiveNumberOrNull(raw.slTriggerPrice)
        : null);
  const fallbackLimitPrice = orderType.includes("TAKE_PROFIT")
    ? positiveNumberOrNull(raw.tpPrice)
    : orderType.includes("STOP")
      ? positiveNumberOrNull(raw.slPrice)
      : null;

  return {
    userId: requiredIdentifier(accountId, "本地账户标识"),
    orderId: `algo:${algoId}`,
    symbol,
    orderType,
    side,
    limitPrice: orderType.includes("MARKET")
      ? null
      : positiveNumberOrNull(raw.price) ?? fallbackLimitPrice,
    averagePrice: positiveNumberOrNull(raw.actualPrice),
    originalQuantity: nonNegativeNumber(raw.quantity ?? 0, "Algo 条件单数量"),
    executedQuantity: 0,
    executedQuoteQuantity: 0,
    stopPrice: triggerPrice,
    status,
    createdAt,
    updatedAt: timestampToIso(lifecycleTime, "Algo 条件单更新时间"),
    positionSide: optionalUpperText(raw.positionSide) ?? "BOTH",
    reduceOnly: Boolean(raw.reduceOnly),
    closePosition: Boolean(raw.closePosition),
    workingType: optionalUpperText(raw.workingType),
    sourceKind: "api-algo",
    actualOrderId: raw.actualOrderId ? String(raw.actualOrderId) : null,
    algoStatus: rawStatus,
  };
}

export function createBinanceUsdmClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Binance HTTP 客户端不可用");
  if (typeof sleep !== "function") throw new TypeError("Binance 限流等待器不可用");
  const weightLimiter = createWeightLimiter({ now, sleep });

  async function getServerTime() {
    let response;
    try {
      response = await fetchImpl(`${BINANCE_FUTURES_ORIGIN}/fapi/v1/time`, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
      });
    } catch {
      throw new Error("无法连接 Binance Futures，请检查网络或 API 访问区域限制");
    }
    const payload = await parseResponse(response, "Binance Futures 校时失败");
    const serverTime = Number(payload?.serverTime);
    if (!Number.isSafeInteger(serverTime) || serverTime <= 0) {
      throw new Error("Binance Futures 返回了无效服务器时间");
    }
    return serverTime;
  }

  async function signedGet(pathname, params, credentials, clockOffset) {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      await weightLimiter.acquire(binanceRequestWeight(pathname, params));
      // 每次重试都重新生成 timestamp 和签名，避免 Retry-After 超过 recvWindow 后签名失效。
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
      }
      query.set("recvWindow", "5000");
      query.set("timestamp", String(normalizeTimestamp(now() + clockOffset, "签名时间")));
      const signature = signBinanceQuery(query.toString(), credentials.apiSecret);
      query.set("signature", signature);
      const endpoint = new URL(pathname, BINANCE_FUTURES_ORIGIN);
      endpoint.search = query.toString();

      let response;
      try {
        response = await fetchImpl(endpoint.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-MBX-APIKEY": credentials.apiKey,
          },
          redirect: "error",
        });
      } catch {
        throw new Error("Binance Futures 私有接口连接失败");
      }
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await weightLimiter.pause(rateLimitDelay(response, attempt));
        continue;
      }
      return parseResponse(response, "Binance Futures 私有接口请求失败");
    }
    throw new Error("Binance Futures 私有接口请求超过重试上限");
  }

  async function signedHistoryGet(pathname, params, credentials, clockOffset) {
    const pendingRanges = [{
      startTime: normalizeTimestamp(params.startTime, "历史查询开始时间"),
      endTime: normalizeTimestamp(params.endTime, "历史查询结束时间"),
    }];
    const completeHistory = [];
    let requestCount = 0;

    while (pendingRanges.length > 0) {
      requestCount += 1;
      if (requestCount > MAX_HISTORY_REQUESTS_PER_WINDOW) {
        throw new Error("Binance 历史订单数量过多，自动分页已达到安全上限，请缩小同步日期范围");
      }

      const range = pendingRanges.shift();
      const payload = await signedGet(
        pathname,
        {
          ...params,
          startTime: range.startTime,
          endTime: range.endTime,
          limit: HISTORY_RESULT_LIMIT,
        },
        credentials,
        clockOffset,
      );
      if (!Array.isArray(payload)) {
        throw new Error("Binance Futures 订单响应格式无效");
      }

      if (payload.length < HISTORY_RESULT_LIMIT) {
        completeHistory.push(...payload);
        continue;
      }

      if (range.startTime >= range.endTime) {
        throw new Error("Binance 同一毫秒内返回至少 1000 条订单，无法确认历史完整性，请缩小范围后重试");
      }
      const midpoint = Math.floor((range.startTime + range.endTime) / 2);
      pendingRanges.unshift(
        { startTime: midpoint + 1, endTime: range.endTime },
      );
      pendingRanges.unshift(
        { startTime: range.startTime, endTime: midpoint },
      );
    }

    return completeHistory;
  }

  /**
   * 收益流水允许省略 symbol，是历史成交交易对的发现入口。
   * Binance 为该接口提供 page 分页；必须读到不足 1000 条才可确认没有被截断。
   */
  async function signedIncomeHistoryGet(range, credentials, clockOffset) {
    const completeHistory = [];
    for (let page = 1; page <= MAX_INCOME_PAGES; page += 1) {
      const payload = await signedGet(
        "/fapi/v1/income",
        {
          startTime: range.startTime,
          endTime: range.endTime,
          page,
          limit: HISTORY_RESULT_LIMIT,
        },
        credentials,
        clockOffset,
      );
      if (!Array.isArray(payload)) {
        throw new Error("Binance Futures 收益流水响应格式无效");
      }
      completeHistory.push(...payload);
      if (payload.length < HISTORY_RESULT_LIMIT) return completeHistory;
    }
    throw new Error("Binance 收益流水数量过多，自动分页已达到安全上限，请缩小同步日期范围");
  }

  return {
    async validateCredentials({ apiKey, apiSecret }) {
      const credentials = validateCredentials({ apiKey, apiSecret });
      const serverTime = await getServerTime();
      const clockOffset = serverTime - normalizeTimestamp(now(), "本机时间");
      const payload = await signedGet("/fapi/v3/balance", {}, credentials, clockOffset);
      if (!Array.isArray(payload) || payload.length === 0) {
        throw new Error("Binance Futures 凭证验证响应格式无效");
      }
      const accountAliases = [...new Set(payload.map((item) =>
        typeof item?.accountAlias === "string" ? item.accountAlias.trim() : "",
      ).filter(Boolean))];
      if (accountAliases.length !== 1 || accountAliases[0].length > 128) {
        throw new Error("Binance Futures 未返回唯一账户别名，无法建立稳定的本地账户标识");
      }
      return { accountAlias: accountAliases[0] };
    },

    async syncOrders({
      apiKey,
      apiSecret,
      accountId,
      symbols,
      knownActiveOrders,
      startTime,
      endTime,
      onProgress,
    }) {
      const credentials = validateCredentials({ apiKey, apiSecret });
      const seedSymbols = normalizeSymbols(symbols);
      const activeOrders = normalizeKnownActiveOrders(knownActiveOrders);
      for (const order of activeOrders) seedSymbols.push(order.symbol);
      const uniqueSeedSymbols = [...new Set(seedSymbols)].sort();
      const range = normalizeHistoryRange(startTime, endTime, now());
      emitProgress(onProgress, { stage: "discovery", message: "正在发现 Binance 交易对" });
      const serverTime = await getServerTime();
      const clockOffset = serverTime - normalizeTimestamp(now(), "本机时间");
      const normalizedOrders = [];
      const normalizedFills = [];

      // 历史订单与逐笔成交接口必须传 symbol；先用无 symbol 的收益流水、当前持仓和全账户挂单发现交易对。
      // 全账户快照端点每次同步只调用一次，不能放进逐币对循环。
      const [incomeHistory, positionRisk, openNormal, openAlgo] = await Promise.all([
        signedIncomeHistoryGet(range, credentials, clockOffset),
        signedGet("/fapi/v3/positionRisk", {}, credentials, clockOffset),
        signedGet("/fapi/v1/openOrders", {}, credentials, clockOffset),
        signedGet("/fapi/v1/openAlgoOrders", {}, credentials, clockOffset),
      ]);
      const normalizedSymbols = discoverSymbols({
        seedSymbols: uniqueSeedSymbols,
        incomeHistory,
        positionRisk,
        openNormal,
        openAlgo,
      });
      if (!Array.isArray(positionRisk)) {
        throw new Error("Binance Futures 当前持仓响应格式无效");
      }
      const normalizedOpenPositions = positionRisk
        .map((raw) => normalizeOpenPosition(raw, accountId))
        .filter(Boolean)
        .sort((left, right) =>
          left.symbol.localeCompare(right.symbol) ||
          left.positionSide.localeCompare(right.positionSide),
        );
      const fundingFeesById = new Map();
      for (const raw of incomeHistory) {
        if (String(raw?.incomeType ?? "").trim().toUpperCase() !== "FUNDING_FEE") continue;
        const fundingFee = normalizeFundingFee(raw, accountId);
        fundingFeesById.set(
          `${fundingFee.userId}\u0000${fundingFee.incomeType}\u0000${fundingFee.transactionId}`,
          fundingFee,
        );
      }
      const fundingFees = [...fundingFeesById.values()].sort(
        (left, right) => Date.parse(left.time) - Date.parse(right.time) ||
          left.transactionId.localeCompare(right.transactionId),
      );
      const openPositions = attachFundingFeesToOpenPositions(
        normalizedOpenPositions,
        fundingFees,
      );
      pushNormalized(normalizedOrders, openNormal, (raw) => normalizeNormalOrder(raw, accountId));
      pushNormalized(normalizedOrders, openAlgo, (raw) => normalizeAlgoOrder(raw, accountId));

      const historyTasks = [];
      for (const symbol of normalizedSymbols) {
        for (const window of splitHistoryRange(range.startTime, range.endTime)) {
          const requestParams = {
            symbol,
            startTime: window.startTime,
            endTime: window.endTime,
            limit: 1000,
          };
          historyTasks.push(
            async () => {
              const payload = await signedHistoryGet(
                "/fapi/v1/allOrders", requestParams, credentials, clockOffset,
              );
              pushNormalized(normalizedOrders, payload, (raw) => normalizeNormalOrder(raw, accountId));
            },
            async () => {
              const payload = await signedHistoryGet(
                "/fapi/v1/allAlgoOrders", requestParams, credentials, clockOffset,
              );
              pushNormalized(normalizedOrders, payload, (raw) => normalizeAlgoOrder(raw, accountId));
            },
            async () => {
              const payload = await signedHistoryGet(
                "/fapi/v1/userTrades", requestParams, credentials, clockOffset,
              );
              pushNormalized(normalizedFills, payload, (raw) => normalizeUserTrade(raw, accountId));
            },
          );
        }
      }
      await runTasksWithConcurrency(historyTasks, HISTORY_CONCURRENCY, (completed, total) => {
        emitProgress(onProgress, {
          stage: "history",
          completed,
          total,
          message: `正在读取 Binance 历史 ${completed}/${total}`,
        });
      });

      const activeOrderTasks = activeOrders.map((activeOrder) => async () => {
        try {
          if (activeOrder.kind === "algo") {
            const payload = await signedGet(
              "/fapi/v1/algoOrder",
              { algoId: activeOrder.orderId },
              credentials,
              clockOffset,
            );
            normalizedOrders.push(normalizeAlgoOrder(payload, accountId));
          } else {
            const payload = await signedGet(
              "/fapi/v1/order",
              { symbol: activeOrder.symbol, orderId: activeOrder.orderId },
              credentials,
              clockOffset,
            );
            normalizedOrders.push(normalizeNormalOrder(payload, accountId));
          }
        } catch (error) {
          if (error?.code !== -2011 && error?.code !== -2013) throw error;
        }
      });
      await runTasksWithConcurrency(activeOrderTasks, HISTORY_CONCURRENCY, (completed, total) => {
        emitProgress(onProgress, {
          stage: "active-orders",
          completed,
          total,
          message: `正在刷新活动订单 ${completed}/${total}`,
        });
      });

      const ordersByKey = new Map();
      for (const order of normalizedOrders) {
        ordersByKey.set(`${order.userId}\u0000${order.symbol}\u0000${order.orderId}`, order);
      }
      const fillsById = new Map();
      for (const fill of normalizedFills) {
        fillsById.set(`${fill.userId}\u0000${fill.symbol}\u0000${fill.tradeId}`, fill);
      }
      const fillsByOrderKey = new Map();
      for (const fill of fillsById.values()) {
        const key = `${fill.userId}\u0000${fill.symbol}\u0000${fill.orderId}`;
        const fills = fillsByOrderKey.get(key) ?? [];
        fills.push(fill);
        fillsByOrderKey.set(key, fills);
      }
      for (const fills of fillsByOrderKey.values()) {
        fills.sort((left, right) =>
          Date.parse(left.time) - Date.parse(right.time) ||
          left.tradeId.localeCompare(right.tradeId),
        );
      }

      const orders = [...ordersByKey.values()]
        .map((order) => {
          const fills = fillsByOrderKey.get(`${order.userId}\u0000${order.symbol}\u0000${order.orderId}`);
          return fills?.length > 0 ? { ...order, fills } : order;
        })
        .sort((left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.orderId.localeCompare(right.orderId),
        );
      const syncedAt = normalizeTimestamp(now(), "同步完成时间");
      emitProgress(onProgress, { stage: "complete", message: "Binance 接口读取完成" });
      return {
        orders,
        symbols: normalizedSymbols,
        openPositions,
        normalOrderCount: orders.filter((order) => order.sourceKind === "api-normal").length,
        algoOrderCount: orders.filter((order) => order.sourceKind === "api-algo").length,
        fillCount: fillsById.size,
        fundingFeeCount: fundingFees.length,
        openPositionCount: openPositions.length,
        syncedAt,
      };
    },
  };
}

function attachFundingFeesToOpenPositions(openPositions, fundingFees) {
  const positionCountBySymbol = new Map();
  for (const position of openPositions) {
    positionCountBySymbol.set(
      position.symbol,
      (positionCountBySymbol.get(position.symbol) ?? 0) + 1,
    );
  }
  const fundingFeesBySymbol = new Map();
  for (const fundingFee of fundingFees) {
    const current = fundingFeesBySymbol.get(fundingFee.symbol) ?? [];
    current.push(fundingFee);
    fundingFeesBySymbol.set(fundingFee.symbol, current);
  }

  return openPositions.map((position) => {
    const symbolFundingFees = fundingFeesBySymbol.get(position.symbol) ?? [];
    const uniquePosition = positionCountBySymbol.get(position.symbol) === 1;
    const matchingAsset = symbolFundingFees.every(
      (fundingFee) => fundingFee.asset === position.marginAsset,
    );
    const fundingFeesKnown = uniquePosition && matchingAsset;
    return {
      ...position,
      fundingFeesKnown,
      fundingFees: fundingFeesKnown ? symbolFundingFees : [],
      ...(!uniquePosition
        ? { fundingFeeNotice: "同一交易对同时存在多空仓位，Binance 资金费流水未提供仓位方向，无法精确归属。" }
        : !matchingAsset
          ? { fundingFeeNotice: "资金费资产与仓位保证金资产不一致，暂未折算计入盈亏。" }
          : {}),
    };
  });
}

function splitHistoryRange(startTime, endTime) {
  const windows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const windowEnd = Math.min(endTime, cursor + QUERY_WINDOW_MS);
    windows.push({ startTime: cursor, endTime: windowEnd });
    cursor = windowEnd + 1;
  }
  return windows;
}

function normalizeHistoryRange(startTime, endTime, currentTime) {
  const start = normalizeTimestamp(startTime, "同步开始时间");
  const end = normalizeTimestamp(endTime, "同步结束时间");
  const current = normalizeTimestamp(currentTime, "本机时间");
  if (start > end) throw new TypeError("同步开始时间不能晚于结束时间");
  if (end > current + 60_000) throw new TypeError("同步结束时间不能晚于当前时间");
  if (end - start > MAX_HISTORY_MS) {
    throw new TypeError("Binance 普通与条件单接口最多同步最近 90 天");
  }
  return { startTime: start, endTime: end };
}

function normalizeSymbols(symbols) {
  if (symbols === undefined || symbols === null) return [];
  if (!Array.isArray(symbols)) throw new TypeError("Binance U 本位交易对必须是数组");
  const normalized = [...new Set(symbols.map(normalizeSymbol))];
  return normalized.sort();
}

function discoverSymbols({ seedSymbols, incomeHistory, positionRisk, openNormal, openAlgo }) {
  const symbols = new Set(seedSymbols);
  for (const [payload, label] of [
    [incomeHistory, "收益流水"],
    [positionRisk, "当前持仓"],
    [openNormal, "基础挂单"],
    [openAlgo, "Algo 挂单"],
  ]) {
    if (!Array.isArray(payload)) throw new Error(`Binance Futures ${label}响应格式无效`);
    for (const item of payload) {
      const symbol = typeof item?.symbol === "string" ? item.symbol.trim() : "";
      // 转账等账户流水没有 symbol，不属于合约交易对。
      if (symbol !== "") symbols.add(normalizeSymbol(symbol));
    }
  }
  return [...symbols].sort();
}

function normalizeSymbol(value) {
  if (typeof value !== "string") throw new TypeError("交易对格式无效");
  const symbol = value.toUpperCase().replace(/[\s/_-]/g, "");
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) throw new TypeError(`交易对格式无效：${value}`);
  return symbol;
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== "object") {
    throw new TypeError("Binance API 凭证格式无效");
  }
  for (const field of ["apiKey", "apiSecret"]) {
    if (typeof credentials[field] !== "string" || credentials[field].trim() === "") {
      throw new TypeError(`Binance ${field} 不能为空`);
    }
  }
  return { apiKey: credentials.apiKey.trim(), apiSecret: credentials.apiSecret.trim() };
}

function pushNormalized(target, payload, normalize) {
  if (!Array.isArray(payload)) throw new Error("Binance Futures 订单响应格式无效");
  for (const raw of payload) target.push(normalize(raw));
}

async function parseResponse(response, fallbackMessage) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${fallbackMessage}：响应不是有效 JSON`);
  }
  if (!response.ok || (payload && typeof payload === "object" && !Array.isArray(payload) && Number(payload.code) < 0)) {
    const upstreamMessage = payload && typeof payload.msg === "string"
      ? sanitizeUpstreamMessage(payload.msg)
      : "请检查 API Key、只读权限、IP 白名单或 Binance 访问限制";
    const error = new Error(`${fallbackMessage}：${upstreamMessage}`);
    if (Number.isFinite(Number(payload?.code))) error.code = Number(payload.code);
    throw error;
  }
  return payload;
}

function sanitizeUpstreamMessage(message) {
  return String(message)
    .replace(/signature=[^&\s]+/gi, "signature=[已隐藏]")
    .replace(/[A-Fa-f0-9]{48,}/g, "[敏感信息已隐藏]")
    .slice(0, 240);
}

function rateLimitDelay(response, attempt) {
  const retryAfterSeconds = Number(response.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(60_000, Math.max(100, Math.round(retryAfterSeconds * 1000)));
  }
  return Math.min(8_000, 1000 * (2 ** attempt));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function binanceRequestWeight(pathname, params) {
  if (pathname === "/fapi/v1/income") return 30;
  if (pathname === "/fapi/v1/openOrders" || pathname === "/fapi/v1/openAlgoOrders") {
    return params?.symbol ? 1 : 40;
  }
  if (pathname === "/fapi/v3/positionRisk" || pathname === "/fapi/v3/balance") return 5;
  if (["/fapi/v1/allOrders", "/fapi/v1/allAlgoOrders", "/fapi/v1/userTrades"].includes(pathname)) {
    return 5;
  }
  return 1;
}

function createWeightLimiter({ now, sleep }) {
  const refillPerMillisecond = REQUEST_WEIGHT_BUDGET / REQUEST_WEIGHT_INTERVAL_MS;
  let available = REQUEST_WEIGHT_BUDGET;
  let updatedAt = Number(now());
  let queue = Promise.resolve();

  async function serialize(task) {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  return {
    acquire(weight) {
      return serialize(async () => {
        const current = Math.max(updatedAt, Number(now()));
        available = Math.min(
          REQUEST_WEIGHT_BUDGET,
          available + Math.max(0, current - updatedAt) * refillPerMillisecond,
        );
        updatedAt = current;
        if (available < weight) {
          const waitMilliseconds = Math.ceil((weight - available) / refillPerMillisecond);
          await sleep(waitMilliseconds);
          updatedAt += waitMilliseconds;
          available = 0;
          return;
        }
        available -= weight;
      });
    },
    pause(milliseconds) {
      return serialize(async () => {
        await sleep(milliseconds);
        updatedAt = Math.max(updatedAt, Number(now())) + milliseconds;
        available = Math.min(available, REQUEST_WEIGHT_BUDGET / 4);
      });
    },
  };
}

async function runTasksWithConcurrency(tasks, concurrency, onComplete) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const results = new Array(tasks.length);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await tasks[index]();
        completed += 1;
        onComplete?.(completed, tasks.length);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function normalizeKnownActiveOrders(orders) {
  if (orders === undefined || orders === null) return [];
  if (!Array.isArray(orders)) throw new TypeError("Binance 活动订单必须是数组");
  const normalized = new Map();
  for (const order of orders) {
    const symbol = normalizeSymbol(order?.symbol);
    const orderId = requiredIdentifier(order?.orderId, "活动订单号");
    const kind = order?.kind === "algo" ? "algo" : order?.kind === "normal" ? "normal" : null;
    if (!kind) throw new TypeError("Binance 活动订单类型无效");
    normalized.set(`${kind}\u0000${symbol}\u0000${orderId}`, { symbol, orderId, kind });
  }
  return [...normalized.values()];
}

function emitProgress(onProgress, progress) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(progress);
  } catch {
    // 进度展示异常不能中断只读同步。
  }
}

function validateRawOrder(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`${label}格式无效`);
  }
}

function normalizeSide(value) {
  const side = requiredUpperText(value, "委托方向");
  if (side !== "BUY" && side !== "SELL") throw new TypeError(`委托方向无效：${side}`);
  return side;
}

function requiredUpperText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label}无效`);
  return value.trim().toUpperCase();
}

function optionalUpperText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : null;
}

function normalizePositionSide(value) {
  const positionSide = optionalUpperText(value) ?? "BOTH";
  if (positionSide !== "BOTH" && positionSide !== "LONG" && positionSide !== "SHORT") {
    throw new TypeError(`持仓方向无效：${positionSide}`);
  }
  return positionSide;
}

function requiredIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (text === "") throw new TypeError(`${label}无效`);
  return text;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label}无效`);
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}无效`);
  return number;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label}无效`);
  return number;
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestampToIso(value, label) {
  return new Date(normalizeTimestamp(value, label)).toISOString();
}

function normalizeTimestamp(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label}无效`);
  return number;
}
