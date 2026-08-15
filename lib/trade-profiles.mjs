import { normalizeCopyTradeMonitorConfig } from "./copy-trade-monitor.mjs";
import {
  DEFAULT_SMART_MONEY_LEAD_PORTFOLIO_ID,
  DEFAULT_SMART_MONEY_PROFILE_ID,
  DEFAULT_SMART_MONEY_SOURCE_URL,
  DEFAULT_SMART_MONEY_TOP_TRADER_ID,
  normalizeSmartMoneySourceConfig,
} from "./smart-money-profile.mjs";

export const DEFAULT_TRADE_PROFILE_ID = "profile-self";
export const XIAOHONG_TRADE_PROFILE_ID = "profile-xiaohong";
export const BINANCE_SMART_MONEY_PROFILE_ID = DEFAULT_SMART_MONEY_PROFILE_ID;

const BUILT_IN_PROFILES = Object.freeze([
  Object.freeze({
    id: DEFAULT_TRADE_PROFILE_ID,
    name: "我的账户",
    createdAt: "2026-07-01T00:00:00.000Z",
  }),
  Object.freeze({
    id: XIAOHONG_TRADE_PROFILE_ID,
    name: "小洪",
    createdAt: "2026-07-31T00:00:00.000Z",
  }),
  Object.freeze({
    id: BINANCE_SMART_MONEY_PROFILE_ID,
    name: "不停梭- · 1万U不停梭挑战",
    createdAt: "2026-08-14T00:00:00.000Z",
    smartMoneySource: Object.freeze({
      sourceUrl: DEFAULT_SMART_MONEY_SOURCE_URL,
      topTraderId: DEFAULT_SMART_MONEY_TOP_TRADER_ID,
      traderName: "不停梭-",
      accountName: "1万U不停梭挑战",
      leadPortfolioId: DEFAULT_SMART_MONEY_LEAD_PORTFOLIO_ID,
    }),
    copyTradeMonitor: Object.freeze({
      enabled: true,
      sourceUrl:
        `https://www.binance.com/zh-CN/copy-trading/lead-details/${DEFAULT_SMART_MONEY_LEAD_PORTFOLIO_ID}`,
      portfolioId: DEFAULT_SMART_MONEY_LEAD_PORTFOLIO_ID,
      intervalSeconds: 60,
      nickname: "不停梭-",
    }),
  }),
]);

/** 合并本机用户列表，并保证旧版“我的账户”和用户指定的“小洪”存在。 */
export function normalizeTradeProfiles(input) {
  const profiles = new Map(BUILT_IN_PROFILES.map((profile) => [profile.id, { ...profile }]));
  for (const value of Array.isArray(input) ? input : []) {
    const profile = normalizeProfile(value);
    if (!profile) continue;
    const existing = profiles.get(profile.id);
    profiles.set(profile.id, existing
      ? { ...existing, ...profile, id: existing.id }
      : profile);
  }
  return [...profiles.values()];
}

/** 创建新的复盘用户；同名用户会导致导入目标含糊，因此不允许重名。 */
export function createTradeProfile(existingProfiles, rawName, now = Date.now()) {
  const name = normalizeProfileName(rawName);
  if (!name) throw new TypeError("用户名称不能为空");
  if (name.length > 20) throw new RangeError("用户名称不能超过 20 个字符");

  const profiles = normalizeTradeProfiles(existingProfiles);
  if (profiles.some((profile) => profile.name.toLocaleLowerCase("zh-CN") ===
    name.toLocaleLowerCase("zh-CN"))) {
    throw new RangeError(`用户“${name}”已经存在`);
  }
  if (!Number.isFinite(Number(now))) throw new TypeError("用户创建时间无效");

  const createdAt = new Date(Number(now)).toISOString();
  const baseId = `profile-${stableHash(`${name}\u0000${createdAt}`)}`;
  let id = baseId;
  let suffix = 2;
  const ids = new Set(profiles.map((profile) => profile.id));
  while (ids.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return { id, name, createdAt };
}

/** 旧记录没有 profileId，兼容归入“我的账户”。 */
export function getTradeProfileId(record) {
  const profileId = typeof record?.profileId === "string"
    ? record.profileId.trim()
    : "";
  return profileId || DEFAULT_TRADE_PROFILE_ID;
}

export function filterRecordsByTradeProfile(records, profileId) {
  const target = requiredProfileId(profileId);
  return (Array.isArray(records) ? records : [])
    .filter((record) => getTradeProfileId(record) === target);
}

export function assignTradeProfile(records, profile, { omitDefault = false } = {}) {
  const normalizedProfile = normalizeProfile(profile);
  if (!normalizedProfile) throw new TypeError("复盘用户无效");
  return (Array.isArray(records) ? records : []).map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("待归档记录必须是对象");
    }
    if (omitDefault && normalizedProfile.id === DEFAULT_TRADE_PROFILE_ID) {
      const { profileId: _profileId, profileName: _profileName, ...legacyRecord } = record;
      return legacyRecord;
    }
    return {
      ...record,
      profileId: normalizedProfile.id,
      profileName: normalizedProfile.name,
    };
  });
}

function normalizeProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = normalizeProfileName(value.name);
  const createdAtMs = Date.parse(value.createdAt);
  if (!id || !name || !Number.isFinite(createdAtMs)) return null;
  const copyTradeMonitor = normalizeCopyTradeMonitorConfig(value.copyTradeMonitor);
  const smartMoneySource = normalizeSmartMoneySourceConfig(value.smartMoneySource);
  return {
    id,
    name,
    createdAt: new Date(createdAtMs).toISOString(),
    ...(copyTradeMonitor ? { copyTradeMonitor } : {}),
    ...(smartMoneySource ? { smartMoneySource } : {}),
  };
}

function normalizeProfileName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function requiredProfileId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("复盘用户 ID 无效");
  }
  return value.trim();
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
