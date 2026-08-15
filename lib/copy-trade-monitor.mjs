const PORTFOLIO_ID_PATTERN = /^\d{12,24}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{3,30}$/;
const ALLOWED_INTERVALS = new Set([30, 60, 300]);
const QUANTITY_EPSILON = 1e-10;

/**
 * 从 Binance 公开带单主页链接中提取 portfolioId。
 * 仅接受官方域名，避免把用户输入变成任意代理地址。
 */
export function extractLeadPortfolioId(input) {
  const value = String(input ?? "").trim();
  if (PORTFOLIO_ID_PATTERN.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("请输入 Binance 公开带单主页链接");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "binance.com" && !hostname.endsWith(".binance.com")) {
    throw new TypeError("只支持 Binance 官方公开带单主页");
  }
  const match = /\/copy-trading\/lead-details\/(\d{12,24})(?:\/|$)/i.exec(
    url.pathname,
  );
  if (!match) throw new TypeError("Binance 带单主页链接中缺少有效 portfolioId");
  return match[1];
}

/** 过滤并规范化跟随用户档案持久化的公开带单监控配置。 */
export function normalizeCopyTradeMonitorConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  let portfolioId;
  try {
    portfolioId = extractLeadPortfolioId(value.portfolioId ?? value.sourceUrl);
  } catch {
    return null;
  }

  const sourceUrl = normalizeSourceUrl(value.sourceUrl, portfolioId);
  if (!sourceUrl) return null;
  const interval = Number(value.intervalSeconds);
  const intervalSeconds = ALLOWED_INTERVALS.has(interval) ? interval : 60;
  const lastSyncedAt = optionalIsoTime(value.lastSyncedAt);
  const lastAttemptAt = optionalIsoTime(value.lastAttemptAt);
  const lastOrderTime = optionalTimestamp(value.lastOrderTime);
  const nickname = optionalText(value.nickname, 80);
  const lastError = optionalText(value.lastError, 500);
  const lastSnapshot = normalizeStoredSnapshot(value.lastSnapshot);

  return {
    enabled: Boolean(value.enabled),
    sourceUrl,
    portfolioId,
    intervalSeconds,
    ...(nickname ? { nickname } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastOrderTime !== null ? { lastOrderTime } : {}),
    ...(lastSnapshot ? { lastSnapshot } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

/**
 * 把 API 路由返回的 Binance 原始响应转换为受控快照。
 * 快照仅保留重建所需字段，不把数百个空仓位写入用户配置。
 */
export function normalizePublicLeadSnapshot(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Binance 公开带单响应无效");
  }
  const detail = unwrapData(input.detail);
  const orderHistory = unwrapData(input.orderHistory);
  const rawPositions = extractArray(unwrapData(input.positions), ["list", "rows", "positions"]);
  const rawOrders = Array.isArray(input.orders)
    ? input.orders
    : extractArray(orderHistory, ["list", "rows", "orders"]);
  const portfolioId = extractLeadPortfolioId(
    options.portfolioId ??
      input.portfolioId ??
      detail?.leadPortfolioId ??
      detail?.copyPortfolioId,
  );
  const fetchedAt = requiredIsoTime(
    options.fetchedAt ?? input.fetchedAt ?? Date.now(),
    "同步时间",
  );
  const positions = rawPositions
    .map((position) => normalizeLeadPosition(position))
    .filter(Boolean)
    .sort(comparePositions);
  const orders = rawOrders
    .map((order) => normalizeLeadOrder(order))
    .filter(Boolean)
    .sort((left, right) =>
      left.orderUpdateTime - right.orderUpdateTime ||
      stableOrderIdentity(left, portfolioId).localeCompare(stableOrderIdentity(right, portfolioId)),
    );
  const totalCandidate = Number(orderHistory?.total ?? input.totalOrders ?? orders.length);

  return {
    portfolioId,
    fetchedAt,
    nickname: optionalText(detail?.nickname ?? input.nickname, 80),
    status: optionalText(detail?.status ?? input.status, 40),
    totalOrders: Number.isInteger(totalCandidate) && totalCandidate >= orders.length
      ? totalCandidate
      : orders.length,
    orders,
    positions,
    warnings: normalizeWarnings(input.warnings),
  };
}

/** 把公开成交事件转换成现有 U 本位订单档案格式。 */
export function createPublicLeadOrderRecords(input, options = {}) {
  const snapshot = isNormalizedSnapshot(input)
    ? input
    : normalizePublicLeadSnapshot(input, options);
  const portfolioId = extractLeadPortfolioId(options.portfolioId ?? snapshot.portfolioId);
  const profileId = requiredText(options.profileId, "复盘用户 ID");
  const profileName = requiredText(options.profileName, "复盘用户名");
  const source = options.source === "smart-money-public"
    ? "smart-money-public"
    : "copy-trade-public";
  const sourceIdentity = source === "smart-money-public"
    ? requiredText(options.sourceIdentity, "聪明钱主页 ID")
    : portfolioId;
  const userId = source === "smart-money-public"
    ? `smart-money:${sourceIdentity}`
    : `copy-public:${portfolioId}`;
  const orderPrefix = source === "smart-money-public" ? "smart-money" : "copy-public";

  return snapshot.orders.map((order) => {
    const orderId = `${orderPrefix}-${stableOrderIdentity(order, portfolioId)}`;
    const updatedAt = new Date(order.orderUpdateTime).toISOString();
    const createdAt = new Date(order.orderTime).toISOString();
    const reduceOnly = inferReduceOnly(order);
    return {
      exchangeProvider: "binance-usdm",
      profileId,
      profileName,
      userId,
      orderId,
      symbol: order.symbol,
      orderType: order.type,
      side: order.side,
      limitPrice: order.type.includes("LIMIT") ? order.avgPrice : null,
      averagePrice: order.avgPrice,
      originalQuantity: order.executedQty,
      executedQuantity: order.executedQty,
      executedQuoteQuantity: cleanNumber(order.executedQty * order.avgPrice),
      stopPrice: null,
      status: "FILLED",
      createdAt,
      updatedAt,
      positionSide: order.positionSide,
      reduceOnly,
      source,
      syncSources: [source],
      reportedRealizedPnl: order.totalPnl,
    };
  });
}

/** 把公开仓位快照转换成现有未平仓复盘所需格式。 */
export function createPublicLeadOpenPositions(input, options = {}) {
  const snapshot = isNormalizedSnapshot(input)
    ? input
    : normalizePublicLeadSnapshot(input, options);
  const portfolioId = extractLeadPortfolioId(options.portfolioId ?? snapshot.portfolioId);
  const profileId = requiredText(options.profileId, "复盘用户 ID");
  const profileName = requiredText(options.profileName, "复盘用户名");
  const source = options.source === "smart-money-public"
    ? "smart-money-public"
    : "copy-trade-public";
  const sourceIdentity = source === "smart-money-public"
    ? requiredText(options.sourceIdentity, "聪明钱主页 ID")
    : portfolioId;
  const userId = source === "smart-money-public"
    ? `smart-money:${sourceIdentity}`
    : `copy-public:${portfolioId}`;

  return snapshot.positions.map((position) => ({
    exchangeProvider: "binance-usdm",
    profileId,
    profileName,
    userId,
    symbol: position.symbol,
    positionSide: position.positionSide,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    breakEvenPrice: position.breakEvenPrice,
    markPrice: position.markPrice,
    unRealizedProfit: position.unRealizedProfit,
    marginAsset: position.marginAsset,
    updateTime: snapshot.fetchedAt,
    syncedAt: snapshot.fetchedAt,
  }));
}

/**
 * 比较两次公开仓位，用于 UI 提示开仓/加仓/减仓/平仓。
 * 差分不携带推测成交价，复盘成交仍只采用公开订单历史。
 */
export function diffPublicLeadSnapshots(previous, next) {
  const before = positionMap(previous?.positions);
  const after = positionMap(next?.positions);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];

  for (const key of keys) {
    const previousPosition = before.get(key);
    const nextPosition = after.get(key);
    const previousQuantity = previousPosition?.quantity ?? 0;
    const quantity = nextPosition?.quantity ?? 0;
    if (nearlyEqual(previousQuantity, quantity)) continue;
    let kind;
    if (previousQuantity <= QUANTITY_EPSILON) kind = "opened";
    else if (quantity <= QUANTITY_EPSILON) kind = "closed";
    else if (quantity > previousQuantity) kind = "increased";
    else kind = "reduced";
    const position = nextPosition ?? previousPosition;
    changes.push({
      kind,
      symbol: position.symbol,
      positionSide: position.positionSide,
      previousQuantity: cleanNumber(previousQuantity),
      quantity: cleanNumber(quantity),
      detectedAt: next?.fetchedAt ?? new Date().toISOString(),
    });
  }
  return changes;
}

/** 仅保存精简仓位快照，避免把 Binance 原始响应写入 SQLite。 */
export function createStoredPublicLeadSnapshot(snapshot) {
  const normalized = isNormalizedSnapshot(snapshot)
    ? snapshot
    : normalizePublicLeadSnapshot(snapshot);
  return {
    fetchedAt: normalized.fetchedAt,
    positions: normalized.positions.map((position) => ({
      symbol: position.symbol,
      positionSide: position.positionSide,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
    })),
  };
}

function normalizeLeadOrder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const side = String(value.side ?? "").trim().toUpperCase();
  const positionSide = normalizePositionSide(value.positionSide);
  const executedQty = finiteNumber(value.executedQty ?? value.executedQuantity ?? value.quantity);
  const avgPrice = finiteNumber(value.avgPrice ?? value.averagePrice ?? value.price);
  const orderUpdateTime = timestampNumber(
    value.orderUpdateTime ?? value.updateTime ?? value.time,
  );
  const orderTime = timestampNumber(value.orderTime ?? value.createTime) ?? orderUpdateTime;
  if (
    !SYMBOL_PATTERN.test(symbol) ||
    (side !== "BUY" && side !== "SELL") ||
    executedQty === null ||
    executedQty <= QUANTITY_EPSILON ||
    avgPrice === null ||
    avgPrice <= 0 ||
    orderUpdateTime === null ||
    orderTime === null
  ) {
    return null;
  }
  return {
    symbol,
    side,
    type: normalizeOrderType(value.type ?? value.orderType),
    positionSide,
    executedQty: cleanNumber(executedQty),
    avgPrice: cleanNumber(avgPrice),
    totalPnl: cleanNumber(finiteNumber(value.totalPnl ?? value.realizedPnl) ?? 0),
    orderUpdateTime,
    orderTime,
  };
}

function normalizeLeadPosition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const signedQuantity = finiteNumber(value.positionAmount ?? value.quantity);
  const entryPrice = finiteNumber(value.entryPrice);
  if (
    !SYMBOL_PATTERN.test(symbol) ||
    signedQuantity === null ||
    Math.abs(signedQuantity) <= QUANTITY_EPSILON ||
    entryPrice === null ||
    entryPrice <= 0
  ) {
    return null;
  }
  const positionSide = normalizePositionSide(value.positionSide);
  const side = positionSide === "SHORT" || (positionSide === "BOTH" && signedQuantity < 0)
    ? "short"
    : "long";
  const breakEven = finiteNumber(value.breakEvenPrice);
  return {
    symbol,
    positionSide,
    side,
    quantity: cleanNumber(Math.abs(signedQuantity)),
    entryPrice: cleanNumber(entryPrice),
    breakEvenPrice: breakEven !== null && breakEven > 0 ? cleanNumber(breakEven) : null,
    markPrice: cleanNumber(finiteNumber(value.markPrice) ?? entryPrice),
    unRealizedProfit: cleanNumber(
      finiteNumber(value.unrealizedProfit ?? value.unRealizedProfit) ?? 0,
    ),
    marginAsset: optionalText(value.collateral ?? value.marginAsset, 20) ?? "USDT",
  };
}

function normalizeStoredSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fetchedAt = optionalIsoTime(value.fetchedAt);
  if (!fetchedAt) return null;
  const positions = (Array.isArray(value.positions) ? value.positions : [])
    .map((position) => {
      if (!position || typeof position !== "object" || Array.isArray(position)) return null;
      const symbol = String(position.symbol ?? "").trim().toUpperCase();
      const positionSide = normalizePositionSide(position.positionSide);
      const quantity = finiteNumber(position.quantity);
      const entryPrice = finiteNumber(position.entryPrice);
      if (
        !SYMBOL_PATTERN.test(symbol) ||
        quantity === null ||
        quantity <= QUANTITY_EPSILON ||
        entryPrice === null ||
        entryPrice <= 0
      ) return null;
      return {
        symbol,
        positionSide,
        quantity: cleanNumber(quantity),
        entryPrice: cleanNumber(entryPrice),
      };
    })
    .filter(Boolean)
    .sort(comparePositions);
  return { fetchedAt, positions };
}

function normalizeSourceUrl(value, portfolioId) {
  const text = String(value ?? "").trim();
  try {
    if (extractLeadPortfolioId(text) !== portfolioId) return null;
    const url = new URL(text);
    return url.toString();
  } catch {
    return `https://www.binance.com/zh-CN/copy-trading/lead-details/${portfolioId}`;
  }
}

function inferReduceOnly(order) {
  if (order.positionSide === "LONG") return order.side === "SELL";
  if (order.positionSide === "SHORT") return order.side === "BUY";
  return Math.abs(order.totalPnl) > QUANTITY_EPSILON;
}

function stableOrderIdentity(order, portfolioId) {
  return stableHash([
    portfolioId,
    order.symbol,
    order.side,
    order.positionSide,
    order.type,
    order.executedQty,
    order.avgPrice,
    order.orderUpdateTime,
    order.orderTime,
  ].join("\u0000"));
}

function isNormalizedSnapshot(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray(value.orders) &&
    Array.isArray(value.positions) &&
    PORTFOLIO_ID_PATTERN.test(String(value.portfolioId ?? "")),
  );
}

function unwrapData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value;
}

function extractArray(value, propertyNames) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const property of propertyNames) {
    if (Array.isArray(value[property])) return value[property];
  }
  return [];
}

function positionMap(positions) {
  return new Map(
    (Array.isArray(positions) ? positions : [])
      .filter((position) =>
        position &&
        typeof position === "object" &&
        SYMBOL_PATTERN.test(String(position.symbol ?? "").toUpperCase()) &&
        Number(position.quantity) > QUANTITY_EPSILON,
      )
      .map((position) => [
        `${String(position.symbol).toUpperCase()}\u0000${normalizePositionSide(position.positionSide)}`,
        {
          ...position,
          symbol: String(position.symbol).toUpperCase(),
          positionSide: normalizePositionSide(position.positionSide),
          quantity: cleanNumber(Number(position.quantity)),
        },
      ]),
  );
}

function comparePositions(left, right) {
  return left.symbol.localeCompare(right.symbol) ||
    left.positionSide.localeCompare(right.positionSide);
}

function normalizePositionSide(value) {
  const normalized = String(value ?? "BOTH").trim().toUpperCase();
  return normalized === "LONG" || normalized === "SHORT" ? normalized : "BOTH";
}

function normalizeOrderType(value) {
  const type = String(value ?? "MARKET").trim().toUpperCase();
  if (type.includes("LIMIT")) return "LIMIT";
  return "MARKET";
}

function normalizeWarnings(value) {
  return (Array.isArray(value) ? value : [])
    .map((warning) => optionalText(warning, 300))
    .filter(Boolean)
    .slice(0, 20);
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label}无效`);
  return text;
}

function optionalText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function optionalIsoTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function requiredIsoTime(value, label) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError(`${label}无效`);
  return new Date(time).toISOString();
}

function optionalTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  return timestampNumber(value);
}

function timestampNumber(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <=
    Math.max(QUANTITY_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 1e-9);
}

function cleanNumber(value) {
  return Number(Number(value).toPrecision(15));
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
