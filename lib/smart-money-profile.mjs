import { extractLeadPortfolioId, normalizeStoredSnapshot } from "./copy-trade-monitor.mjs";

const TOP_TRADER_ID_PATTERN = /^\d{12,24}$/;
const PROFILE_NAME_MAX_LENGTH = 20;

export const DEFAULT_SMART_MONEY_TOP_TRADER_ID = "5078319056891617536";
export const DEFAULT_SMART_MONEY_LEAD_PORTFOLIO_ID = "5090588047188778241";
export const DEFAULT_SMART_MONEY_PROFILE_ID =
  `profile-smart-money-${DEFAULT_SMART_MONEY_TOP_TRADER_ID}`;
export const DEFAULT_SMART_MONEY_SOURCE_URL =
  `https://www.binance.com/zh-CN/smart-money/profile/${DEFAULT_SMART_MONEY_TOP_TRADER_ID}`;

/** 从 Binance 官方聪明钱主页链接中提取 topTraderId。 */
export function extractSmartMoneyProfileId(input) {
  const value = String(input ?? "").trim();
  if (TOP_TRADER_ID_PATTERN.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("请输入 Binance 聪明钱主页链接");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "binance.com" && !hostname.endsWith(".binance.com")) {
    throw new TypeError("只支持 Binance 官方聪明钱主页");
  }
  const match = /\/smart-money\/profile\/(\d{12,24})(?:\/|$)/i.exec(url.pathname);
  if (!match) throw new TypeError("Binance 聪明钱主页链接中缺少有效 topTraderId");
  return match[1];
}

/** 关联带单可选；分享最新操作的主页直接使用本机登录同步。 */
export function normalizeSmartMoneyProfileSnapshot(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Binance 聪明钱主页响应无效");
  }
  const outer = unwrapData(input);
  const profile = unwrapData(outer?.profile ?? outer);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("Binance 聪明钱主页资料无效");
  }

  const topTraderId = extractSmartMoneyProfileId(
    options.topTraderId ?? outer?.topTraderId ?? profile.topTraderId,
  );
  if (
    profile.topTraderId &&
    extractSmartMoneyProfileId(profile.topTraderId) !== topTraderId
  ) {
    throw new TypeError("Binance 聪明钱主页身份不一致");
  }

  const leadPortfolioId = optionalLeadPortfolioId(
    profile.futuresCopyTradePortfolioId ?? profile.leadPortfolioId,
  );
  if (!leadPortfolioId && profile.sharingLatestRecord !== true) {
    throw new TypeError(
      "该聪明钱主页未共享最新操作，且没有关联可公开读取的合约带单档案；仅仓位快照无法生成完整买卖回放。",
    );
  }

  const fetchedAt = requiredIsoTime(
    options.fetchedAt ?? outer?.fetchedAt ?? Date.now(),
    "主页同步时间",
  );
  return {
    topTraderId,
    fetchedAt,
    sourceUrl: smartMoneySourceUrl(topTraderId),
    traderName: optionalText(profile.traderName, 80),
    accountName: optionalText(profile.accountName, 80),
    introduction: optionalText(profile.introduction, 500),
    leadPortfolioId,
    sharingPosition: Boolean(profile.sharingPosition),
    sharingPositionHistory: Boolean(profile.sharingPositionHistory),
    sharingLatestRecord: Boolean(profile.sharingLatestRecord),
  };
}

/** 创建或刷新一个由聪明钱主页驱动的独立复盘用户。 */
export function createSmartMoneyTradeProfile(existingProfiles, input, now = Date.now()) {
  const snapshot = isNormalizedSnapshot(input)
    ? input
    : normalizeSmartMoneyProfileSnapshot(input);
  const profiles = Array.isArray(existingProfiles) ? existingProfiles : [];
  const id = smartMoneyTradeProfileId(snapshot.topTraderId);
  const existing = profiles.find((profile) =>
    profile?.id === id ||
    profile?.smartMoneySource?.topTraderId === snapshot.topTraderId,
  );
  const createdAt = existing?.createdAt ?? requiredIsoTime(now, "用户创建时间");
  const name = uniqueProfileName(
    composeProfileName(snapshot),
    profiles.filter((profile) => profile?.id !== id),
    snapshot.topTraderId,
  );
  const previousMonitor = existing?.copyTradeMonitor?.portfolioId === snapshot.leadPortfolioId
    ? existing.copyTradeMonitor
    : null;
  const previousSource = normalizeSmartMoneySourceConfig(existing?.smartMoneySource, {
    legacyMonitor: existing?.copyTradeMonitor,
  });
  const baseProfile = existing && typeof existing === "object" ? { ...existing } : {};
  delete baseProfile.copyTradeMonitor;
  const smartMoneySource = normalizeSmartMoneySourceConfig({
    ...(previousSource ?? {}),
    sourceUrl: snapshot.sourceUrl,
    topTraderId: snapshot.topTraderId,
    traderName: snapshot.traderName,
    accountName: snapshot.accountName,
    leadPortfolioId: snapshot.leadPortfolioId,
    orderIdentity: previousSource?.orderIdentity ?? snapshot.topTraderId,
    sharingPosition: snapshot.sharingPosition,
    sharingLatestRecord: snapshot.sharingLatestRecord,
    lastResolvedAt: snapshot.fetchedAt,
  });

  return {
    ...baseProfile,
    id,
    name,
    createdAt,
    smartMoneySource,
    ...(snapshot.leadPortfolioId ? { copyTradeMonitor: {
      ...(previousMonitor ?? {}),
      enabled: smartMoneySource.enabled,
      sourceUrl:
        `https://www.binance.com/zh-CN/copy-trading/lead-details/${snapshot.leadPortfolioId}`,
      portfolioId: snapshot.leadPortfolioId,
      intervalSeconds: smartMoneySource.intervalSeconds,
      ...(snapshot.traderName ? { nickname: snapshot.traderName } : {}),
    } } : {}),
  };
}

export function upsertSmartMoneyTradeProfile(existingProfiles, snapshot, now = Date.now()) {
  const profiles = Array.isArray(existingProfiles) ? existingProfiles : [];
  const profile = createSmartMoneyTradeProfile(profiles, snapshot, now);
  const existingIndex = profiles.findIndex((item) => item?.id === profile.id);
  if (existingIndex < 0) {
    return { profiles: [...profiles, profile], profile, created: true };
  }
  const nextProfiles = [...profiles];
  nextProfiles[existingIndex] = profile;
  return { profiles: nextProfiles, profile, created: false };
}

/** 过滤 user_profiles.payload 中的聪明钱来源配置。 */
export function normalizeSmartMoneySourceConfig(value, { legacyMonitor = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let topTraderId;
  let leadPortfolioId;
  try {
    topTraderId = extractSmartMoneyProfileId(value.topTraderId ?? value.sourceUrl);
    leadPortfolioId = optionalLeadPortfolioId(value.leadPortfolioId);
  } catch {
    return null;
  }
  const sourceUrl = smartMoneySourceUrl(topTraderId);
  const traderName = optionalText(value.traderName, 80);
  const accountName = optionalText(value.accountName, 80);
  const lastResolvedAt = optionalIsoTime(value.lastResolvedAt);
  const sharingPosition = value.sharingPosition === true;
  const sharingLatestRecord = value.sharingLatestRecord === true;
  const state = typeof value.enabled === "boolean"
    ? value : { ...(legacyMonitor ?? {}), ...value };
  const interval = Number(state.intervalSeconds);
  const lastSyncedAt = optionalIsoTime(state.lastSyncedAt);
  const lastAttemptAt = optionalIsoTime(state.lastAttemptAt);
  const lastError = optionalText(state.lastError, 500);
  const lastSnapshot = normalizeStoredSnapshot(state.lastSnapshot);
  const lastOrderTime = Number(state.lastOrderTime);
  const orderIdentity = String(value.orderIdentity ?? leadPortfolioId ?? topTraderId);
  if (!TOP_TRADER_ID_PATTERN.test(orderIdentity)) return null;
  return {
    sourceUrl,
    topTraderId,
    leadPortfolioId,
    orderIdentity,
    enabled: state.enabled !== false,
    intervalSeconds: [30, 60, 300].includes(interval) ? interval : 60,
    sharingPosition,
    sharingLatestRecord,
    ...(traderName ? { traderName } : {}),
    ...(accountName ? { accountName } : {}),
    ...(lastResolvedAt ? { lastResolvedAt } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastError ? { lastError } : {}),
    ...(lastSnapshot ? { lastSnapshot } : {}),
    ...(Number.isFinite(lastOrderTime) && lastOrderTime > 0 ? { lastOrderTime } : {}),
  };
}

export function smartMoneyTradeProfileId(topTraderId) {
  return `profile-smart-money-${extractSmartMoneyProfileId(topTraderId)}`;
}

function smartMoneySourceUrl(topTraderId) {
  return `https://www.binance.com/zh-CN/smart-money/profile/${topTraderId}`;
}

function composeProfileName(snapshot) {
  const parts = [snapshot.traderName, snapshot.accountName].filter(Boolean);
  const unique = [...new Set(parts)];
  const combined = unique.join(" · ") || `聪明钱 ${snapshot.topTraderId.slice(-6)}`;
  return combined.slice(0, PROFILE_NAME_MAX_LENGTH);
}

function uniqueProfileName(baseName, existingProfiles, topTraderId) {
  const names = new Set(
    existingProfiles
      .map((profile) => String(profile?.name ?? "").trim().toLocaleLowerCase("zh-CN"))
      .filter(Boolean),
  );
  if (!names.has(baseName.toLocaleLowerCase("zh-CN"))) return baseName;
  const suffix = ` · ${topTraderId.slice(-4)}`;
  return `${baseName.slice(0, PROFILE_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function isNormalizedSnapshot(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    TOP_TRADER_ID_PATTERN.test(String(value.topTraderId ?? "")) &&
    (value.leadPortfolioId === null || TOP_TRADER_ID_PATTERN.test(String(value.leadPortfolioId ?? ""))) &&
    typeof value.sourceUrl === "string" &&
    typeof value.fetchedAt === "string",
  );
}

function optionalLeadPortfolioId(value) {
  if (value === undefined || value === null || value === "") return null;
  return extractLeadPortfolioId(value);
}

function unwrapData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value;
}

function optionalText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function optionalIsoTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function requiredIsoTime(value, label) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError(`${label}无效`);
  return new Date(time).toISOString();
}
