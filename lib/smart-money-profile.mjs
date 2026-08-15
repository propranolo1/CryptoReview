import { extractLeadPortfolioId } from "./copy-trade-monitor.mjs";

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

/** 规范化公开主页资料，并要求存在可公开读取成交的关联合约带单档案。 */
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

  let leadPortfolioId;
  try {
    leadPortfolioId = extractLeadPortfolioId(
      profile.futuresCopyTradePortfolioId ?? profile.leadPortfolioId,
    );
  } catch {
    throw new TypeError(
      "该聪明钱主页没有关联可公开读取的合约带单档案，无法生成真实买卖回放。",
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

  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    id,
    name,
    createdAt,
    smartMoneySource: {
      sourceUrl: snapshot.sourceUrl,
      topTraderId: snapshot.topTraderId,
      traderName: snapshot.traderName,
      accountName: snapshot.accountName,
      leadPortfolioId: snapshot.leadPortfolioId,
      lastResolvedAt: snapshot.fetchedAt,
    },
    copyTradeMonitor: {
      ...(previousMonitor ?? {}),
      enabled: true,
      sourceUrl:
        `https://www.binance.com/zh-CN/copy-trading/lead-details/${snapshot.leadPortfolioId}`,
      portfolioId: snapshot.leadPortfolioId,
      intervalSeconds: previousMonitor?.intervalSeconds ?? 60,
      ...(snapshot.traderName ? { nickname: snapshot.traderName } : {}),
    },
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
export function normalizeSmartMoneySourceConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let topTraderId;
  let leadPortfolioId;
  try {
    topTraderId = extractSmartMoneyProfileId(value.topTraderId ?? value.sourceUrl);
    leadPortfolioId = extractLeadPortfolioId(value.leadPortfolioId);
  } catch {
    return null;
  }
  const sourceUrl = smartMoneySourceUrl(topTraderId);
  const traderName = optionalText(value.traderName, 80);
  const accountName = optionalText(value.accountName, 80);
  const lastResolvedAt = optionalIsoTime(value.lastResolvedAt);
  return {
    sourceUrl,
    topTraderId,
    leadPortfolioId,
    ...(traderName ? { traderName } : {}),
    ...(accountName ? { accountName } : {}),
    ...(lastResolvedAt ? { lastResolvedAt } : {}),
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
    TOP_TRADER_ID_PATTERN.test(String(value.leadPortfolioId ?? "")) &&
    typeof value.sourceUrl === "string" &&
    typeof value.fetchedAt === "string",
  );
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
