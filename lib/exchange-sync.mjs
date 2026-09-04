export const INCREMENTAL_SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

const BINANCE_TERMINAL_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "CANCELLED",
  "EXPIRED",
  "REJECTED",
  "TRIGGERED",
  "FINISHED",
]);
const BINANCE_SYMBOL_PATTERN = /^[\p{L}\p{N}]{1,20}(?:USDT|USDC|BUSD)$/u;

/** 规范化 Binance 官方交易对，同时保留中文等 Unicode 字母。 */
export function normalizeBinanceSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[\s/_-]/gu, "");
}

/** Binance symbol 只允许字母和数字，避免把查询参数字符带入请求。 */
export function isBinanceSymbol(value) {
  return typeof value === "string" && BINANCE_SYMBOL_PATTERN.test(value);
}

/** 计算交易所同步的实际时间范围；快速更新保留一天重叠以吸收延迟入账。 */
export function resolveExchangeSyncRange({
  startTime,
  endTime,
  incremental = false,
  lastSyncedAt = null,
}) {
  const requestedStartTime = requiredTimestamp(startTime, "同步开始时间");
  const normalizedEndTime = requiredTimestamp(endTime, "同步结束时间");
  if (requestedStartTime > normalizedEndTime) {
    throw new TypeError("同步开始时间不能晚于结束时间");
  }

  const normalizedLastSyncedAt = optionalTimestamp(lastSyncedAt);
  const useIncremental = Boolean(incremental && normalizedLastSyncedAt !== null);
  const effectiveStartTime = useIncremental
    ? Math.max(
      requestedStartTime,
      Math.min(
        normalizedEndTime,
        normalizedLastSyncedAt - INCREMENTAL_SYNC_OVERLAP_MS,
      ),
    )
    : requestedStartTime;

  return {
    requestedStartTime,
    startTime: effectiveStartTime,
    endTime: normalizedEndTime,
    incremental: useIncremental,
  };
}

/** 从本机档案挑出仍可能变化的 Binance 委托，供精确查询刷新。 */
export function selectActiveBinanceOrders(orders, accountId) {
  if (!Array.isArray(orders)) return [];
  const normalizedAccountId = String(accountId ?? "").trim();
  const selected = new Map();

  for (const order of orders) {
    if (!order || String(order.userId ?? "").trim() !== normalizedAccountId) continue;
    if (!isBinanceApiOrder(order)) continue;
    const status = String(order.status ?? order.algoStatus ?? "").trim().toUpperCase();
    if (!status || BINANCE_TERMINAL_STATUSES.has(status)) continue;
    const symbol = normalizeBinanceSymbol(order.symbol);
    const rawOrderId = String(order.orderId ?? "").trim();
    if (!isBinanceSymbol(symbol) || !rawOrderId) continue;

    const kind = order.sourceKind === "api-algo" || rawOrderId.startsWith("algo:")
      ? "algo"
      : "normal";
    const orderId = kind === "algo" ? rawOrderId.replace(/^algo:/, "") : rawOrderId;
    if (!orderId) continue;
    selected.set(`${kind}\u0000${symbol}\u0000${orderId}`, { symbol, orderId, kind });
  }

  return [...selected.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol) ||
    left.orderId.localeCompare(right.orderId) ||
    left.kind.localeCompare(right.kind),
  );
}

/** 从本机档案选择当前 Binance 账户曾经同步过的交易对，已平仓订单也必须保留。 */
export function selectKnownBinanceSymbols(orders, accountId) {
  if (!Array.isArray(orders)) return [];
  const normalizedAccountId = String(accountId ?? "").trim();
  const selected = new Set();

  for (const order of orders) {
    if (!order || String(order.userId ?? "").trim() !== normalizedAccountId) continue;
    if (!isBinanceApiOrder(order)) continue;
    const symbol = normalizeBinanceSymbol(order.symbol);
    if (!isBinanceSymbol(symbol)) continue;
    selected.add(symbol);
  }

  return [...selected].sort();
}

function isBinanceApiOrder(order) {
  if (order.exchangeProvider && order.exchangeProvider !== "binance-usdm") return false;
  return order.sourceKind === "api-normal" || order.sourceKind === "api-algo";
}

function requiredTimestamp(value, label) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError(`${label}无效`);
  }
  return timestamp;
}

function optionalTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}
