import { normalizeStoredSnapshot } from './copy-trade-monitor.mjs';

/** 只展示尚无完整复盘的已同步仓位，不将快照转换为成交或参与盈亏计算。 */
export function getUnreplayedSmartMoneyPositions(profile, trades) {
  const source = profile?.smartMoneySource;
  if (!profile?.id || !/^\d{12,24}$/.test(String(source?.topTraderId ?? ''))) return null;
  const snapshot = normalizeStoredSnapshot(source.lastSnapshot);
  if (!snapshot) return null;
  const currentTrades = Array.isArray(trades) ? trades : [];
  const positions = snapshot.positions.filter(position => !currentTrades.some(trade => {
    const open = trade?.openPosition;
    if (trade?.profileId !== profile.id || open?.userId !== `smart-money:${source.topTraderId}` ||
        open.symbol !== position.symbol || open.positionSide !== position.positionSide) return false;
    const quantity = Number(open.quantity);
    const syncedAt = Date.parse(open.syncedAt);
    // 旧复盘或数量不一致时保留最新快照，让真实持仓仍可见。
    return Number.isFinite(quantity) && Number.isFinite(syncedAt) &&
      syncedAt >= Date.parse(snapshot.fetchedAt) &&
      Math.abs(quantity - position.quantity) <= Math.max(1, quantity, position.quantity) * 1e-9;
  }));
  return positions.length ? { fetchedAt: snapshot.fetchedAt, positions } : null;
}
