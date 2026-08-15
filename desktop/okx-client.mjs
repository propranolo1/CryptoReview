import { createHmac } from "node:crypto";

const OKX_ORIGINS = Object.freeze({
  global: "https://openapi.okx.com",
  us: "https://us.okx.com",
  eea: "https://eea.okx.com",
});
const HISTORY_LIMIT = 100;
const MAX_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
const RECENT_ORDER_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 4096;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_CODES = new Set(["50011", "50040"]);
const ALGO_TYPES = ["conditional", "oco", "trigger", "move_order_stop"];
const ALGO_HISTORY_STATES = [
  "effective",
  "canceled",
  "order_failed",
  "partially_failed",
];

/**
 * 按 OKX V5 规则对 timestamp + method + requestPath + body 计算
 * Base64 HMAC-SHA256 签名。
 */
export function signOkxRequest(
  timestamp,
  method,
  requestPath,
  body,
  apiSecret,
) {
  const normalizedTimestamp = requiredText(timestamp, "OKX 签名时间");
  const normalizedMethod = requiredText(method, "OKX 请求方法").toUpperCase();
  const normalizedPath = requiredText(requestPath, "OKX 请求路径");
  if (!normalizedPath.startsWith("/")) {
    throw new TypeError("OKX 请求路径必须以 / 开头");
  }
  if (typeof body !== "string") throw new TypeError("OKX 签名请求体必须是字符串");
  const secret = requiredText(apiSecret, "OKX Secret Key");
  return createHmac("sha256", secret)
    .update(`${normalizedTimestamp}${normalizedMethod}${normalizedPath}${body}`)
    .digest("base64");
}

/**
 * 只接受 USDT 结算的线性永续。OKX 的 sz/pos/fillSz 均以“张”为单位，
 * 统一订单结构则使用基币数量，因此按 ctVal × ctMult 转换。
 */
export function normalizeOkxInstrument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (String(raw.instType ?? "").toUpperCase() !== "SWAP") return null;
  if (String(raw.ctType ?? "").toLowerCase() !== "linear") return null;
  if (String(raw.settleCcy ?? "").toUpperCase() !== "USDT") return null;

  const instId = String(raw.instId ?? "").trim().toUpperCase();
  const match = /^([A-Z0-9]+)-USDT-SWAP$/.exec(instId);
  if (!match) return null;
  const baseAsset = match[1];
  const contractValueCurrency = String(raw.ctValCcy ?? baseAsset).trim().toUpperCase();
  if (contractValueCurrency !== baseAsset) return null;
  const contractValue = optionalPositiveNumber(raw.ctVal);
  if (contractValue === null) return null;
  const contractMultiplier = String(raw.ctMult ?? "").trim() === ""
    ? 1
    : optionalPositiveNumber(raw.ctMult);
  if (contractMultiplier === null) return null;
  return {
    instId,
    symbol: `${baseAsset}USDT`,
    baseAsset,
    quoteAsset: "USDT",
    settleAsset: "USDT",
    contractValue,
    contractMultiplier,
    baseQuantityPerContract: cleanNumber(contractValue * contractMultiplier),
  };
}

/** 将 OKX 普通委托转换为项目统一订单结构。 */
export function normalizeOkxNormalOrder(raw, accountId, instrument) {
  validateRecord(raw, "OKX 基础委托");
  const metadata = validateInstrument(instrument, raw.instId);
  const originalQuantity = contractsToBase(raw.sz, metadata, "OKX 基础委托数量", true);
  const executedQuantity = contractsToBase(
    raw.accFillSz ?? 0,
    metadata,
    "OKX 基础委托成交数量",
    true,
  );
  const averagePrice = optionalPositiveNumber(raw.avgPx);
  const limitPrice = optionalPositiveNumber(raw.px);
  const executionPrice = averagePrice ?? limitPrice;

  return {
    userId: requiredIdentifier(accountId, "OKX 本地账户标识"),
    orderId: requiredIdentifier(raw.ordId, "OKX 基础委托 ordId"),
    symbol: metadata.symbol,
    orderType: requiredText(raw.ordType, "OKX 基础委托类型").toUpperCase(),
    side: normalizeSide(raw.side),
    limitPrice,
    averagePrice,
    originalQuantity,
    executedQuantity,
    executedQuoteQuantity: executionPrice === null
      ? 0
      : cleanNumber(executedQuantity * executionPrice),
    stopPrice: null,
    status: normalizeNormalStatus(raw.state),
    createdAt: timestampToIso(raw.cTime, "OKX 基础委托创建时间"),
    updatedAt: timestampToIso(
      raw.uTime ?? raw.fillTime ?? raw.cTime,
      "OKX 基础委托更新时间",
    ),
    positionSide: normalizePositionSide(raw.posSide),
    reduceOnly: normalizeBoolean(raw.reduceOnly),
    closePosition: false,
    workingType: null,
    sourceKind: "okx-api-normal",
    provider: "okx",
    exchangeProvider: "okx-swap",
    instrumentId: metadata.instId,
  };
}

/** 将 OKX 逐笔成交转换为统一成交与净手续费证据。 */
export function normalizeOkxFill(raw, accountId, instrument) {
  validateRecord(raw, "OKX 逐笔成交");
  const metadata = validateInstrument(instrument, raw.instId);
  const quantity = contractsToBase(raw.fillSz, metadata, "OKX 逐笔成交数量");
  const price = positiveNumber(raw.fillPx, "OKX 逐笔成交价格");
  const rawFee = finiteNumber(raw.fee, "OKX 逐笔成交手续费");

  return {
    userId: requiredIdentifier(accountId, "OKX 本地账户标识"),
    tradeId: requiredIdentifier(raw.tradeId, "OKX 逐笔成交 tradeId"),
    billId: requiredIdentifier(raw.billId, "OKX 逐笔成交 billId"),
    orderId: requiredIdentifier(raw.ordId, "OKX 逐笔成交 ordId"),
    symbol: metadata.symbol,
    side: normalizeSide(raw.side),
    positionSide: normalizePositionSide(raw.posSide),
    price,
    quantity,
    quoteQuantity: cleanNumber(quantity * price),
    // OKX：负数是费用支出、正数是返佣。统一结构：正数是费用、负数是返佣。
    commission: cleanNumber(-rawFee),
    commissionAsset: requiredText(raw.feeCcy, "OKX 逐笔成交手续费资产").toUpperCase(),
    realizedPnl: finiteNumber(raw.fillPnl ?? 0, "OKX 逐笔成交已实现盈亏"),
    time: timestampToIso(raw.fillTime, "OKX 逐笔成交时间"),
    maker: String(raw.execType ?? "").toUpperCase() === "M",
    provider: "okx",
    exchangeProvider: "okx-swap",
    instrumentId: metadata.instId,
  };
}

/** 将 OKX 当前持仓转换为未平仓快照；零仓位不写入。 */
export function normalizeOkxOpenPosition(raw, accountId, instrument) {
  validateRecord(raw, "OKX 当前持仓");
  const metadata = validateInstrument(instrument, raw.instId);
  const contracts = finiteNumber(raw.pos, "OKX 当前持仓数量");
  if (contracts === 0) return null;
  const positionSide = normalizePositionSide(raw.posSide);
  const side = positionSide === "LONG"
    ? "long"
    : positionSide === "SHORT"
      ? "short"
      : contracts > 0
        ? "long"
        : "short";

  return {
    userId: requiredIdentifier(accountId, "OKX 本地账户标识"),
    symbol: metadata.symbol,
    positionSide,
    side,
    quantity: cleanNumber(Math.abs(contracts) * metadata.baseQuantityPerContract),
    entryPrice: positiveNumber(raw.avgPx, "OKX 当前持仓开仓均价"),
    breakEvenPrice: optionalPositiveNumber(raw.bePx),
    markPrice: positiveNumber(raw.markPx, "OKX 当前持仓标记价格"),
    unRealizedProfit: finiteNumber(raw.upl, "OKX 当前持仓未实现盈亏"),
    marginAsset: String(raw.ccy ?? "").trim().toUpperCase() || metadata.settleAsset,
    // 当前仓位接口没有可靠的开仓时间，仅保存快照更新时间。
    updateTime: timestampToIso(raw.uTime, "OKX 当前持仓更新时间"),
    provider: "okx",
    exchangeProvider: "okx-swap",
    instrumentId: metadata.instId,
  };
}

/**
 * 一个 OKX conditional/OCO 可能同时包含 TP 与 SL，因此返回 0 至 2 条风险订单。
 * trigger/trailing 也会保留为条件单证据，但不会冒充基础成交。
 */
export function normalizeOkxAlgoOrders(raw, accountId, instrument) {
  validateRecord(raw, "OKX Algo 条件单");
  const metadata = validateInstrument(instrument, raw.instId);
  const algoId = requiredIdentifier(raw.algoId, "OKX Algo 条件单 algoId");
  const algoType = requiredText(raw.ordType, "OKX Algo 条件单类型").toLowerCase();
  const createdAt = timestampToIso(raw.cTime, "OKX Algo 条件单创建时间");
  const lifecycleTimestamp = firstPositiveTimestamp(raw.triggerTime, raw.uTime, raw.cTime);
  const updatedAt = timestampToIso(lifecycleTimestamp, "OKX Algo 条件单更新时间");
  const quantity = contractsToBase(
    raw.sz ?? 0,
    metadata,
    "OKX Algo 条件单数量",
    true,
  );
  const common = {
    userId: requiredIdentifier(accountId, "OKX 本地账户标识"),
    symbol: metadata.symbol,
    side: normalizeSide(raw.side),
    averagePrice: optionalPositiveNumber(raw.actualPx),
    originalQuantity: quantity,
    executedQuantity: 0,
    executedQuoteQuantity: 0,
    createdAt,
    updatedAt,
    positionSide: normalizePositionSide(raw.posSide),
    reduceOnly: normalizeBoolean(raw.reduceOnly),
    closePosition: positiveNumberOrZero(raw.closeFraction) > 0,
    sourceKind: "okx-api-algo",
    provider: "okx",
    exchangeProvider: "okx-swap",
    instrumentId: metadata.instId,
    actualOrderId: optionalIdentifier(raw.ordId),
    algoStatus: String(raw.state ?? "").toUpperCase(),
    algoType: algoType.toUpperCase(),
    lifecycleTimeEstimated:
      !isPositiveTimestamp(raw.triggerTime) && !isPositiveTimestamp(raw.uTime),
  };

  if (algoType === "conditional" || algoType === "oco") {
    const legs = [];
    const takeProfit = algoLeg(raw, "tp", algoId, common);
    const stopLoss = algoLeg(raw, "sl", algoId, common);
    if (takeProfit) legs.push(takeProfit);
    if (stopLoss) legs.push(stopLoss);
    return legs;
  }

  if (algoType === "trigger") {
    const triggerPrice = optionalPositiveNumber(raw.triggerPx);
    if (triggerPrice === null) return [];
    const limitPrice = normalizedAlgoLimitPrice(raw.ordPx);
    return [{
      ...common,
      orderId: `okx-algo:${algoId}:trigger`,
      orderType: limitPrice === null ? "TRIGGER_MARKET" : "TRIGGER_LIMIT",
      limitPrice,
      stopPrice: triggerPrice,
      status: normalizeAlgoStatus(raw.state),
      workingType: normalizeWorkingType(raw.triggerPxType),
    }];
  }

  if (algoType === "move_order_stop") {
    const triggerPrice =
      optionalPositiveNumber(raw.moveTriggerPx) ??
      optionalPositiveNumber(raw.activePx);
    return [{
      ...common,
      orderId: `okx-algo:${algoId}:trailing`,
      orderType: "TRAILING",
      limitPrice: null,
      stopPrice: triggerPrice,
      status: normalizeAlgoStatus(raw.state),
      workingType: null,
      callbackRatio: optionalPositiveNumber(raw.callbackRatio),
      callbackSpread: optionalPositiveNumber(raw.callbackSpread),
    }];
  }

  return [];
}

export function createOkxClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("OKX HTTP 客户端不可用");
  if (typeof now !== "function") throw new TypeError("OKX 时钟不可用");
  if (typeof sleep !== "function") throw new TypeError("OKX 限流等待器不可用");

  async function getServerTime(region) {
    const payload = await publicGet("/api/v5/public/time", {}, region, "OKX 校时失败");
    const serverTime = Number(payload[0]?.ts);
    if (!Number.isSafeInteger(serverTime) || serverTime <= 0) {
      throw new Error("OKX 返回了无效服务器时间");
    }
    return serverTime;
  }

  async function publicGet(pathname, params, region, fallbackMessage) {
    const query = buildQuery(params);
    const requestPath = query === "" ? pathname : `${pathname}?${query}`;
    const endpoint = new URL(requestPath, originForRegion(region));
    let response;
    try {
      response = await fetchImpl(endpoint.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
      });
    } catch {
      throw new Error(`${fallbackMessage}：无法连接 OKX`);
    }
    const payload = await readJsonResponse(response, fallbackMessage);
    assertSuccessfulPayload(response, payload, fallbackMessage);
    return requirePayloadData(payload, fallbackMessage);
  }

  async function signedGet(
    pathname,
    params,
    credentials,
    clockOffset,
    fallbackMessage = "OKX 私有接口请求失败",
  ) {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const query = buildQuery(params);
      const requestPath = query === "" ? pathname : `${pathname}?${query}`;
      const timestamp = new Date(
        normalizeTimestamp(now() + clockOffset, "OKX 签名时间"),
      ).toISOString();
      const signature = signOkxRequest(
        timestamp,
        "GET",
        requestPath,
        "",
        credentials.apiSecret,
      );
      const endpoint = new URL(requestPath, originForRegion(credentials.region));
      let response;
      try {
        response = await fetchImpl(endpoint.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "OK-ACCESS-KEY": credentials.apiKey,
            "OK-ACCESS-SIGN": signature,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": credentials.passphrase,
          },
          redirect: "error",
        });
      } catch {
        throw new Error(`${fallbackMessage}：无法连接 OKX 私有接口`);
      }
      const payload = await readJsonResponse(response, fallbackMessage);
      if (isRateLimited(response, payload) && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(rateLimitDelay(response, attempt));
        continue;
      }
      assertSuccessfulPayload(response, payload, fallbackMessage);
      return requirePayloadData(payload, fallbackMessage);
    }
    throw new Error(`${fallbackMessage}：超过限流重试上限`);
  }

  async function paginatedSignedGet(
    pathname,
    params,
    cursorField,
    credentials,
    clockOffset,
  ) {
    const complete = [];
    let after = null;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await signedGet(
        pathname,
        {
          ...params,
          after,
          limit: HISTORY_LIMIT,
        },
        credentials,
        clockOffset,
      );
      complete.push(...data);
      if (data.length < HISTORY_LIMIT) return complete;
      const cursor = optionalIdentifier(data.at(-1)?.[cursorField]);
      if (!cursor || seenCursors.has(cursor)) {
        throw new Error(`OKX ${pathname} 分页游标无效，无法确认历史完整性`);
      }
      seenCursors.add(cursor);
      after = cursor;
    }
    throw new Error(`OKX ${pathname} 分页达到安全上限，请缩小同步日期范围`);
  }

  return {
    async validateCredentials(input) {
      const credentials = validateCredentials(input);
      const serverTime = await getServerTime(credentials.region);
      const clockOffset = serverTime - normalizeTimestamp(now(), "OKX 本机时间");
      const config = await signedGet(
        "/api/v5/account/config",
        {},
        credentials,
        clockOffset,
        "OKX 凭证验证失败",
      );
      if (config.length !== 1) {
        throw new Error("OKX 未返回唯一账户配置，无法建立稳定本地账户标识");
      }
      const accountUid = requiredIdentifier(config[0]?.uid, "OKX 账户 uid");
      if (accountUid.length > 128) throw new Error("OKX 账户 uid 无效");
      return { accountUid, region: credentials.region };
    },

    async syncOrders(input) {
      const credentials = validateCredentials(input);
      const accountId = requiredIdentifier(input?.accountId, "OKX 本地账户标识");
      const range = normalizeHistoryRange(input?.startTime, input?.endTime, now());
      const serverTime = await getServerTime(credentials.region);
      const clockOffset = serverTime - normalizeTimestamp(now(), "OKX 本机时间");

      const instrumentPayload = await publicGet(
        "/api/v5/public/instruments",
        { instType: "SWAP" },
        credentials.region,
        "OKX 永续合约元数据读取失败",
      );
      const instruments = new Map();
      for (const raw of instrumentPayload) {
        const instrument = normalizeOkxInstrument(raw);
        if (instrument) instruments.set(instrument.instId, instrument);
      }
      if (instruments.size === 0) {
        throw new Error("OKX 未返回可用的 USDT 线性永续合约元数据");
      }

      const pendingOrders = await paginatedSignedGet(
        "/api/v5/trade/orders-pending",
        { instType: "SWAP" },
        "ordId",
        credentials,
        clockOffset,
      );
      const recentStart = Math.max(
        range.startTime,
        serverTime - RECENT_ORDER_HISTORY_MS,
      );
      const recentOrders = recentStart <= range.endTime
        ? await paginatedSignedGet(
            "/api/v5/trade/orders-history",
            {
              instType: "SWAP",
              begin: recentStart,
              end: range.endTime,
            },
            "ordId",
            credentials,
            clockOffset,
          )
        : [];
      const archivedOrders = await paginatedSignedGet(
        "/api/v5/trade/orders-history-archive",
        {
          instType: "SWAP",
          begin: range.startTime,
          end: range.endTime,
        },
        "ordId",
        credentials,
        clockOffset,
      );
      const fillPayload = await paginatedSignedGet(
        "/api/v5/trade/fills-history",
        {
          instType: "SWAP",
          begin: range.startTime,
          end: range.endTime,
        },
        "billId",
        credentials,
        clockOffset,
      );
      const positionPayload = await signedGet(
        "/api/v5/account/positions",
        { instType: "SWAP" },
        credentials,
        clockOffset,
      );

      const algoPayload = [];
      for (const ordType of ALGO_TYPES) {
        algoPayload.push(...await paginatedSignedGet(
          "/api/v5/trade/orders-algo-pending",
          { ordType },
          "algoId",
          credentials,
          clockOffset,
        ));
        for (const state of ALGO_HISTORY_STATES) {
          const history = await paginatedSignedGet(
            "/api/v5/trade/orders-algo-history",
            { ordType, state },
            "algoId",
            credentials,
            clockOffset,
          );
          algoPayload.push(...history.filter((raw) => algoTouchesRange(raw, range)));
        }
      }

      const warnings = [];
      const rawOrdersById = new Map();
      for (const raw of [...archivedOrders, ...recentOrders, ...pendingOrders]) {
        const instrument = instruments.get(normalizeInstrumentId(raw?.instId));
        if (!instrument) {
          if (raw?.instId) warnings.push(unsupportedInstrumentWarning(raw.instId));
          continue;
        }
        const identity = `${instrument.instId}\u0000${String(raw.ordId ?? "")}`;
        rawOrdersById.set(identity, raw);
      }

      const normalizedOrders = [];
      for (const raw of rawOrdersById.values()) {
        const instrument = instruments.get(normalizeInstrumentId(raw.instId));
        normalizedOrders.push(normalizeOkxNormalOrder(raw, accountId, instrument));
      }

      const fillsById = new Map();
      for (const raw of fillPayload) {
        const instrument = instruments.get(normalizeInstrumentId(raw?.instId));
        if (!instrument) {
          if (raw?.instId) warnings.push(unsupportedInstrumentWarning(raw.instId));
          continue;
        }
        const fill = normalizeOkxFill(raw, accountId, instrument);
        fillsById.set(`${fill.userId}\u0000${fill.symbol}\u0000${fill.billId}`, fill);
      }

      const algoOrdersById = new Map();
      for (const raw of algoPayload) {
        const instrument = instruments.get(normalizeInstrumentId(raw?.instId));
        if (!instrument) {
          if (raw?.instId) warnings.push(unsupportedInstrumentWarning(raw.instId));
          continue;
        }
        for (const order of normalizeOkxAlgoOrders(raw, accountId, instrument)) {
          algoOrdersById.set(
            `${order.userId}\u0000${order.symbol}\u0000${order.orderId}`,
            order,
          );
        }
      }

      const openPositions = [];
      for (const raw of positionPayload) {
        const instrument = instruments.get(normalizeInstrumentId(raw?.instId));
        if (!instrument) {
          if (raw?.instId) warnings.push(unsupportedInstrumentWarning(raw.instId));
          continue;
        }
        const position = normalizeOkxOpenPosition(raw, accountId, instrument);
        if (position) openPositions.push(position);
      }
      openPositions.sort((left, right) =>
        left.symbol.localeCompare(right.symbol) ||
        left.positionSide.localeCompare(right.positionSide)
      );

      const fillsByOrder = new Map();
      for (const fill of fillsById.values()) {
        const key = `${fill.userId}\u0000${fill.symbol}\u0000${fill.orderId}`;
        const fills = fillsByOrder.get(key) ?? [];
        fills.push(fill);
        fillsByOrder.set(key, fills);
      }
      for (const fills of fillsByOrder.values()) {
        fills.sort((left, right) =>
          Date.parse(left.time) - Date.parse(right.time) ||
          left.tradeId.localeCompare(right.tradeId)
        );
      }

      const normalOrders = normalizedOrders.map((order) => {
        const key = `${order.userId}\u0000${order.symbol}\u0000${order.orderId}`;
        const fills = fillsByOrder.get(key);
        return fills?.length ? { ...order, fills } : order;
      });
      const orders = [...normalOrders, ...algoOrdersById.values()].sort((left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.orderId.localeCompare(right.orderId)
      );
      const symbols = [...new Set([
        ...orders.map((order) => order.symbol),
        ...fillsById.values().map((fill) => fill.symbol),
        ...openPositions.map((position) => position.symbol),
      ])].sort();

      return {
        accountId,
        orders,
        symbols,
        openPositions,
        normalOrderCount: normalOrders.length,
        algoOrderCount: algoOrdersById.size,
        fillCount: fillsById.size,
        openPositionCount: openPositions.length,
        syncedAt: normalizeTimestamp(now(), "OKX 同步完成时间"),
        warnings: deduplicateWarnings(warnings),
      };
    },
  };
}

function algoLeg(raw, kind, algoId, common) {
  const isTakeProfit = kind === "tp";
  const triggerPrice = optionalPositiveNumber(
    isTakeProfit ? raw.tpTriggerPx : raw.slTriggerPx,
  );
  if (triggerPrice === null) return null;
  const orderPrice = isTakeProfit ? raw.tpOrdPx : raw.slOrdPx;
  const limitPrice = normalizedAlgoLimitPrice(orderPrice);
  const market = String(orderPrice ?? "").trim() === "-1";
  const orderType = isTakeProfit
    ? market ? "TAKE_PROFIT_MARKET" : "TAKE_PROFIT"
    : market ? "STOP_MARKET" : "STOP";
  return {
    ...common,
    orderId: `okx-algo:${algoId}:${kind}`,
    orderType,
    limitPrice,
    stopPrice: triggerPrice,
    status: normalizeAlgoLegStatus(raw.state, raw.actualSide, kind),
    workingType: normalizeWorkingType(
      isTakeProfit ? raw.tpTriggerPxType : raw.slTriggerPxType,
    ),
  };
}

function normalizeAlgoLegStatus(state, actualSide, kind) {
  const normalizedState = String(state ?? "").toLowerCase();
  const normalizedActualSide = String(actualSide ?? "").toLowerCase();
  if (normalizedState === "effective" || normalizedState === "partially_effective") {
    if (normalizedActualSide === kind) return "FILLED";
    if (normalizedActualSide === "tp" || normalizedActualSide === "sl") return "CANCELED";
    return "FILLED";
  }
  return normalizeAlgoStatus(normalizedState);
}

function normalizeAlgoStatus(value) {
  const state = String(value ?? "").trim().toLowerCase();
  if (state === "live" || state === "pause") return "NEW";
  if (state === "effective" || state === "partially_effective") return "FILLED";
  if (state === "canceled") return "CANCELED";
  if (state === "order_failed" || state === "partially_failed") return "EXPIRED";
  throw new TypeError(`OKX Algo 条件单状态无效：${value}`);
}

function normalizeNormalStatus(value) {
  const state = requiredText(value, "OKX 基础委托状态").toLowerCase();
  if (state === "live") return "NEW";
  if (state === "partially_filled") return "PARTIALLY_FILLED";
  if (state === "filled") return "FILLED";
  if (state === "canceled" || state === "mmp_canceled") return "CANCELED";
  throw new TypeError(`OKX 基础委托状态无效：${value}`);
}

function normalizeWorkingType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (type === "mark") return "MARK_PRICE";
  if (type === "index") return "INDEX_PRICE";
  if (type === "last" || type === "") return "CONTRACT_PRICE";
  return type.toUpperCase();
}

function normalizedAlgoLimitPrice(value) {
  const text = String(value ?? "").trim();
  if (text === "" || text === "-1") return null;
  return optionalPositiveNumber(text);
}

function contractsToBase(value, instrument, label, allowZero = false) {
  const contracts = allowZero
    ? nonNegativeNumber(value, label)
    : positiveNumber(value, label);
  return cleanNumber(contracts * instrument.baseQuantityPerContract);
}

function validateInstrument(instrument, rawInstrumentId) {
  if (!instrument || typeof instrument !== "object") {
    throw new TypeError("OKX 合约元数据无效");
  }
  const expected = normalizeInstrumentId(rawInstrumentId);
  if (expected === "" || expected !== instrument.instId) {
    throw new TypeError(`OKX 合约元数据不匹配：${rawInstrumentId}`);
  }
  if (
    typeof instrument.symbol !== "string" ||
    !Number.isFinite(instrument.baseQuantityPerContract) ||
    instrument.baseQuantityPerContract <= 0
  ) {
    throw new TypeError("OKX 合约元数据无效");
  }
  return instrument;
}

function normalizeHistoryRange(startTime, endTime, currentTime) {
  const start = normalizeTimestamp(startTime, "OKX 同步开始时间");
  const end = normalizeTimestamp(endTime, "OKX 同步结束时间");
  const current = normalizeTimestamp(currentTime, "OKX 本机时间");
  if (start > end) throw new TypeError("OKX 同步开始时间不能晚于结束时间");
  if (end > current + 60_000) throw new TypeError("OKX 同步结束时间不能晚于当前时间");
  if (end - start > MAX_HISTORY_MS) {
    throw new TypeError("OKX 订单与成交接口最多同步最近 90 天");
  }
  return { startTime: start, endTime: end };
}

function algoTouchesRange(raw, range) {
  const created = Number(raw?.cTime);
  if (!Number.isSafeInteger(created) || created <= 0 || created > range.endTime) return false;
  const state = String(raw?.state ?? "").toLowerCase();
  if (state === "live" || state === "pause") return true;
  const lifecycle = firstPositiveTimestamp(raw?.triggerTime, raw?.uTime, raw?.cTime);
  return lifecycle >= range.startTime;
}

function validateCredentials(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("OKX API 凭证格式无效");
  }
  return {
    apiKey: validateSecret(input.apiKey, "OKX API Key"),
    apiSecret: validateSecret(input.apiSecret, "OKX Secret Key"),
    passphrase: validateSecret(input.passphrase, "OKX Passphrase"),
    region: normalizeRegion(input.region),
  };
}

function normalizeRegion(value) {
  const region = String(value ?? "global").trim().toLowerCase();
  if (!Object.hasOwn(OKX_ORIGINS, region)) {
    throw new TypeError("OKX 区域必须是 global、us 或 eea");
  }
  return region;
}

function originForRegion(region) {
  return OKX_ORIGINS[normalizeRegion(region)];
}

function validateSecret(value, label) {
  const text = requiredText(value, label);
  if (text.length > 512) throw new TypeError(`${label}长度无效`);
  return text;
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  return query.toString();
}

async function readJsonResponse(response, fallbackMessage) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${fallbackMessage}：响应不是有效 JSON`);
  }
}

function assertSuccessfulPayload(response, payload, fallbackMessage) {
  const okxCode = payload && typeof payload === "object" ? String(payload.code ?? "") : "";
  if (!response.ok || okxCode !== "0") {
    const upstreamMessage = typeof payload?.msg === "string" && payload.msg.trim() !== ""
      ? sanitizeUpstreamMessage(payload.msg)
      : "请检查 API Key、Passphrase、只读权限、IP 白名单和账户区域";
    throw new Error(`${fallbackMessage}：${upstreamMessage}`);
  }
}

function requirePayloadData(payload, fallbackMessage) {
  if (!Array.isArray(payload?.data)) {
    throw new Error(`${fallbackMessage}：OKX 响应 data 不是数组`);
  }
  return payload.data;
}

function isRateLimited(response, payload) {
  return response.status === 429 || RATE_LIMIT_CODES.has(String(payload?.code ?? ""));
}

function rateLimitDelay(response, attempt) {
  const retryAfter = Number(response.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(60_000, Math.max(100, Math.round(retryAfter * 1000)));
  }
  return Math.min(8_000, 1000 * (2 ** attempt));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitizeUpstreamMessage(value) {
  return String(value)
    .replace(/OK-ACCESS-(?:KEY|SIGN|PASSPHRASE)[^,\s]*/gi, "[敏感信息已隐藏]")
    .replace(/[A-Fa-f0-9]{48,}/g, "[敏感信息已隐藏]")
    .slice(0, 240);
}

function unsupportedInstrumentWarning(instId) {
  return {
    code: "unsupported_okx_instrument",
    instrumentId: String(instId),
    message: `${instId} 不是受支持的 OKX USDT 线性永续，已跳过。`,
  };
}

function deduplicateWarnings(warnings) {
  const result = new Map();
  for (const warning of warnings) {
    result.set(`${warning.code}\u0000${warning.instrumentId}`, warning);
  }
  return [...result.values()].sort((left, right) =>
    left.instrumentId.localeCompare(right.instrumentId)
  );
}

function normalizeInstrumentId(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeSide(value) {
  const side = requiredText(value, "OKX 委托方向").toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    throw new TypeError(`OKX 委托方向无效：${value}`);
  }
  return side;
}

function normalizePositionSide(value) {
  const side = String(value ?? "net").trim().toUpperCase();
  if (side === "NET" || side === "") return "BOTH";
  if (side === "LONG" || side === "SHORT") return side;
  throw new TypeError(`OKX 持仓方向无效：${value}`);
}

function normalizeBoolean(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (
    value === false ||
    value === "false" ||
    value === 0 ||
    value === "0" ||
    value === "" ||
    value === undefined ||
    value === null
  ) return false;
  throw new TypeError(`OKX 布尔字段无效：${value}`);
}

function firstPositiveTimestamp(...values) {
  for (const value of values) {
    if (isPositiveTimestamp(value)) return Number(value);
  }
  throw new TypeError("OKX 时间字段无效");
}

function isPositiveTimestamp(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0;
}

function timestampToIso(value, label) {
  return new Date(normalizeTimestamp(value, label)).toISOString();
}

function normalizeTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError(`${label}无效`);
  }
  return timestamp;
}

function validateRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}格式无效`);
  }
}

function requiredIdentifier(value, label) {
  const text = String(value ?? "").trim();
  if (text === "") throw new TypeError(`${label}无效`);
  return text;
}

function optionalIdentifier(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}不能为空`);
  }
  return value.trim();
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}无效`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label}无效`);
  return number;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label}无效`);
  return number;
}

function optionalPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveNumberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function cleanNumber(value) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toPrecision(15));
}
