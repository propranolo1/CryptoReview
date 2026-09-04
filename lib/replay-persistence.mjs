/** API 更新结束前，显式等待合并后的订单与复盘都写入桌面数据库。 */
export async function persistDesktopReplaySnapshot(
  desktopApi,
  { orders, trades },
) {
  if (
    !desktopApi ||
    typeof desktopApi.saveReplaySnapshot !== "function"
  ) {
    throw new TypeError("桌面复盘保存接口不可用");
  }
  if (!Array.isArray(orders) || !Array.isArray(trades)) {
    throw new TypeError("桌面复盘快照必须包含订单和复盘数组");
  }

  await desktopApi.saveReplaySnapshot({ orders, trades });
}

/** 只返回用户明确星标的复盘记录，并保持原有列表顺序。 */
export function filterStarredReplayTrades(trades) {
  return (Array.isArray(trades) ? trades : []).filter(
    (trade) => trade?.starred === true,
  );
}

/** 切换单笔复盘的星标状态，不修改原数组或其它交易对象。 */
export function toggleReplayTradeStar(trades, tradeId) {
  const currentTrades = Array.isArray(trades) ? trades : [];
  const targetId = typeof tradeId === "string" ? tradeId.trim() : "";
  if (!currentTrades.some((trade) => trade?.id === targetId)) {
    throw new RangeError("要星标的复盘记录不存在");
  }
  return currentTrades.map((trade) => trade?.id === targetId
    ? { ...trade, starred: trade.starred !== true }
    : trade);
}

/**
 * 删除一条可导入复盘及仅由它引用的原始订单。
 * 共享条件单证据会继续保留，避免破坏同一档案中的其它复盘。
 */
export function removeReplayTradeRecord(orders, trades, tradeId) {
  const currentOrders = Array.isArray(orders) ? orders : [];
  const currentTrades = Array.isArray(trades) ? trades : [];
  const targetId = typeof tradeId === "string" ? tradeId.trim() : "";
  const target = currentTrades.find((trade) => trade?.id === targetId);
  if (!target) throw new RangeError("要删除的复盘记录不存在");
  if (!targetId.startsWith("import-")) {
    throw new RangeError("内置示例记录不能删除");
  }

  const nextTrades = currentTrades.filter((trade) => trade !== target);
  const targetOrderIds = replayOrderIds(target);
  const retainedOrderIds = new Set(
    nextTrades
      .filter((trade) => sameReplayOrderScope(trade, target))
      .flatMap(replayOrderIds),
  );
  const removableOrderIds = new Set(
    targetOrderIds.filter((orderId) => !retainedOrderIds.has(orderId)),
  );
  const nextOrders = currentOrders.filter((order) => {
    if (!sameReplayOrderScope(order, target)) return true;
    return !orderIdentities(order).some((orderId) => removableOrderIds.has(orderId));
  });

  return {
    orders: nextOrders,
    trades: nextTrades,
    removedTrade: target,
    removedOrderCount: currentOrders.length - nextOrders.length,
  };
}

function replayOrderIds(trade) {
  return uniqueStrings([
    ...(Array.isArray(trade?.sourceOrderIds) ? trade.sourceOrderIds : []),
    trade?.sourceEntryOrderId,
    trade?.orderIds?.entry,
    trade?.orderIds?.takeProfit,
    trade?.orderIds?.exit,
  ]);
}

function orderIdentities(order) {
  return uniqueStrings([
    order?.orderId,
    order?.actualOrderId,
    ...(Array.isArray(order?.sourceOrderAliases) ? order.sourceOrderAliases : []),
  ]);
}

function sameReplayOrderScope(left, right) {
  return recordProfileId(left) === recordProfileId(right) &&
    normalizeSymbol(left?.symbol) === normalizeSymbol(right?.symbol);
}

function recordProfileId(record) {
  return typeof record?.profileId === "string" && record.profileId.trim() !== ""
    ? record.profileId.trim()
    : "profile-self";
}

function normalizeSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[\s/_-]/g, "");
}

function uniqueStrings(values) {
  return [...new Set(values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean))];
}
