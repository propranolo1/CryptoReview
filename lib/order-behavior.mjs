const DEFAULT_RAPID_MS = 60_000;
const DEFAULT_LONG_MS = 30 * 60_000;

/** 只使用本账户 API 的委托与逐笔成交证据，不用更新时间反推首笔成交。 */
export function analyzeApiOrderBehavior(order, options = {}) {
  const provider = apiProvider(order);
  const result = { orderId: order?.orderId ?? "", provider, side: order?.side ?? "", orderType: order?.orderType ?? "",
    createdAt: order?.createdAt ?? null, firstFillTime: null, waitMs: null,
    lastPriceChangeTime: null, lastChangeWaitMs: null, kind: "unknown", label: "无法判断", explanation: "缺少真实委托或完整逐笔成交，请完整同步补齐。" };
  if (!provider) return { ...result, kind: "unsupported", explanation: "仅支持自己账户的 Binance／OKX API 订单。" };
  const type = String(order.orderType).toUpperCase();
  if (order.sourceKind.endsWith("algo") || /STOP|TAKE_PROFIT|TRAILING|TRIGGER|CONDITIONAL/.test(type)) {
    return { ...result, kind: "conditional", label: "条件委托", explanation: "创建至触发的时间不等于限价单等待，不据此推断入场行为。" };
  }
  if (type === "MARKET") return { ...result, kind: "market", label: "市价入场", explanation: "市价委托不计算限价挂单等待，不能据此确认决策过程。" };
  if (!["LIMIT", "POST_ONLY", "IOC", "FOK"].includes(type)) return result;
  const created = timestamp(order.createdAt);
  const fillsById = new Map();
  for (const fill of Array.isArray(order.fills) ? order.fills : []) {
    if (fill?.orderId !== order.orderId || fill?.symbol !== order.symbol ||
      timestamp(fill.time) === null || !(Number(fill.quantity) > 0)) return result;
    fillsById.set(String(fill.tradeId ?? `${fill.time}:${fill.price}:${fill.quantity}`), fill);
  }
  const fills = [...fillsById.values()];
  const quantity = fills.reduce((sum, fill) => sum + Number(fill.quantity), 0);
  const executed = Number(order.executedQuantity);
  if (created === null || fills.length === 0 || !(executed > 0) ||
    Math.abs(quantity - executed) > Math.max(1e-10, executed * 1e-8)) return result;
  const first = fills.reduce((earliest, fill) => Math.min(earliest, timestamp(fill.time)), Infinity);
  if (first < created) return result;
  const waitMs = first - created;
  const rapid = positiveOption(options.rapidFillMs, DEFAULT_RAPID_MS);
  const long = Math.max(rapid + 1, positiveOption(options.longWaitMs, DEFAULT_LONG_MS));
  const changes = (Array.isArray(order.amendmentHistory?.changes) ? order.amendmentHistory.changes : [])
    .filter(change => timestamp(change?.time) !== null && timestamp(change.time) >= created && timestamp(change.time) <= first &&
      Number(change.beforePrice) > 0 && Number(change.afterPrice) > 0 && Number(change.beforePrice) !== Number(change.afterPrice))
    .sort((a, b) => timestamp(a.time) - timestamp(b.time));
  const last = changes.at(-1);
  const lastChangeWaitMs = last ? first - timestamp(last.time) : null;
  const complete = order.amendmentHistory?.status === "complete" && timestamp(order.amendmentHistory.checkedAt) >= first;
  const evidence = { ...result, firstFillTime: new Date(first).toISOString(), waitMs,
    lastPriceChangeTime: last?.time ?? null, lastChangeWaitMs };
  const aggressive = last && (order.side === "BUY" ? last.afterPrice > last.beforePrice : last.afterPrice < last.beforePrice);
  if (aggressive && lastChangeWaitMs <= rapid && waitMs > rapid) {
    return { ...evidence, kind: "chased", label: waitMs >= long ? "久挂后追价（疑似）" : "改单后追价（疑似）",
      explanation: `${order.side === "BUY" ? "提高买价" : "降低卖价"}后很快首次成交，属于更积极的报价；是否点击追单、当时距市价多远无法确认。` };
  }
  const unknownChase = complete ? "" : " 改单历史不完整，追价情况未知。";
  if (waitMs <= rapid) return { ...evidence, kind: "quick", label: "新挂单快速成交",
    explanation: `订单创建后很快首次成交，不代表突然做出决策，也不能确认下单时距市价多近。${unknownChase}` };
  if (waitMs >= long) return { ...evidence, kind: complete && changes.length === 0 ? "resting" : "long-wait",
    label: complete && changes.length === 0 ? "提前挂单等待成交" : "久挂后成交",
    explanation: complete && changes.length === 0 ? "创建至首次成交等待较久，已取得的完整改单记录中没有成交前改价。" : `创建至首次成交等待较久。${unknownChase || "成交前曾改价，不能归为一直原价等待。"}` };
  return { ...evidence, kind: "waiting", label: "普通等待成交", explanation: `等待时长处于快速成交和久挂阈值之间。${unknownChase}` };
}

/** 按复盘内的明确账户身份关联订单，缺少身份时不猜测、跨账户或跨来源匹配。 */
export function getTradeEntryOrderBehaviors(trade, orders, options = {}) {
  const sources = trade?.syncSources ?? [];
  const provider = sources.includes("binance-api") ? "binance-usdm" : sources.includes("okx-api") ? "okx-swap" : null;
  if (!provider) return [];
  const accountId = trade.sourceAccountId ?? trade.openPosition?.userId;
  const visibleEntries = trade.entries?.filter(entry => options.asOfTime === undefined ||
    (timestamp(entry.entryTime) !== null && timestamp(entry.entryTime) <= options.asOfTime));
  const ids = [...new Set((trade.entries?.length ? visibleEntries.map(entry => entry.sourceOrderId) :
    options.asOfTime === undefined || timestamp(trade.entryTime) <= options.asOfTime ? [trade.sourceEntryOrderId] : []).filter(Boolean))];
  return ids.map(orderId => {
    const matches = (Array.isArray(orders) ? orders : []).filter(order => order.orderId === orderId &&
      order.symbol === trade.symbol && order.userId === accountId && apiProvider(order) === provider &&
      (order.profileId ?? "profile-self") === (trade.profileId ?? "profile-self"));
    if (!accountId || matches.length !== 1) return { ...analyzeApiOrderBehavior(null), orderId, provider, kind: "unknown", label: "无法判断",
      explanation: "缺少唯一的同账户 API 委托证据，请完整同步补齐。" };
    return analyzeApiOrderBehavior(matches[0], options);
  });
}

function apiProvider(order) {
  if (["api-normal", "api-algo"].includes(order?.sourceKind)) return "binance-usdm";
  if (["okx-api-normal", "okx-api-algo"].includes(order?.sourceKind)) return "okx-swap";
  return null;
}
function timestamp(value) {
  const parsed = typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function positiveOption(value, fallback) { return Number.isFinite(value) && value > 0 ? value : fallback; }
