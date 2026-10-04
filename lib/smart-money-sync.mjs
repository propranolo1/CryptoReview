import { normalizeSmartMoneySourceConfig } from "./smart-money-profile.mjs";
import { normalizePublicLeadSnapshot, normalizeSmartMoneyTradeSnapshot } from "./copy-trade-monitor.mjs";

// 登录始终由官网窗口负责；这里仅消费桌面桥接返回的白名单交易数据。
export async function readSmartMoneyTradeSnapshot(source, {
  desktopApi = null,
  fetchImpl = globalThis.fetch,
  interactive = false,
  fullHistory = false,
  onAuthorizationRequired,
} = {}) {
  const config = normalizeSmartMoneySourceConfig(source);
  if (!config) throw new Error("聪明钱主页配置无效，无法开始同步。");
  if (!config.sharingLatestRecord && !config.leadPortfolioId) {
    throw new Error("该聪明钱主页未共享最新操作，且没有关联公开带单档案；仅仓位快照无法生成完整买卖回放。");
  }
  let latest = null;
  if ((config.sharingPosition || config.sharingLatestRecord) && desktopApi?.syncSmartMoneyLatestRecords) {
    const request = {
      topTraderId: config.topTraderId,
      includePositions: config.sharingPosition,
      includeLatestRecords: config.sharingLatestRecord,
    };
    latest = await desktopApi.syncSmartMoneyLatestRecords(request);
    if (latest.authorizationRequired) {
      if (!interactive) throw new Error(latest.message);
      onAuthorizationRequired?.();
      const authorization = await desktopApi.authorizeSmartMoney({ ...request, sourceUrl: config.sourceUrl });
      if (!authorization.completed) throw new Error("Binance 登录窗口已关闭，本次同步已取消。");
      latest = authorization.syncResult;
      if (latest.authorizationRequired) throw new Error("Binance 登录未完成，暂时无法读取该主页共享的仓位或操作记录。");
    }
    if (config.sharingLatestRecord) {
      return {
        usingLatestRecords: true,
        snapshot: normalizeSmartMoneyTradeSnapshot({
          topTraderId: config.topTraderId,
          fetchedAt: latest.fetchedAt,
          nickname: config.traderName,
          positions: latest.positions,
          orderHistory: { total: latest.total, list: latest.records },
          warnings: latest.warnings,
        }, { topTraderId: config.topTraderId }),
      };
    }
  }
  if (!config.leadPortfolioId) {
    throw new Error("该主页需要在桌面版中复用 Binance 登录读取共享操作，请使用桌面版同步。");
  }
  const response = await fetchImpl("/api/copy-trade/lead-portfolio", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ portfolioId: config.leadPortfolioId, fullHistory: fullHistory === true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(typeof payload?.message === "string"
    ? payload.message : "Binance 公开带单同步失败，请稍后重试。");
  const publicSnapshot = normalizePublicLeadSnapshot(payload, { portfolioId: config.leadPortfolioId });
  return {
    usingLatestRecords: false,
    snapshot: normalizeSmartMoneyTradeSnapshot({
      ...publicSnapshot,
      topTraderId: config.topTraderId,
      ...(latest ? {
        fetchedAt: latest.fetchedAt,
        positions: latest.positions,
        warnings: [...publicSnapshot.warnings, ...latest.warnings],
      } : {}),
    }, { topTraderId: config.topTraderId }),
  };
}
