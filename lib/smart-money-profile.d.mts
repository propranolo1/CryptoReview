import type { TradeProfile } from "./trade-profiles.mjs";
import type { CopyTradeMonitorInterval, StoredPublicLeadSnapshot } from "./copy-trade-monitor.mjs";

export interface SmartMoneySourceConfig {
  sourceUrl: string;
  topTraderId: string;
  leadPortfolioId: string | null;
  orderIdentity: string;
  enabled: boolean;
  intervalSeconds: CopyTradeMonitorInterval;
  lastSyncedAt?: string;
  lastAttemptAt?: string;
  lastOrderTime?: number;
  lastSnapshot?: StoredPublicLeadSnapshot;
  lastError?: string;
  sharingPosition: boolean;
  sharingLatestRecord: boolean;
  traderName?: string;
  accountName?: string;
  lastResolvedAt?: string;
}

export interface SmartMoneyProfileSnapshot {
  topTraderId: string;
  fetchedAt: string;
  sourceUrl: string;
  traderName: string | null;
  accountName: string | null;
  introduction: string | null;
  leadPortfolioId: string | null;
  sharingPosition: boolean;
  sharingPositionHistory: boolean;
  sharingLatestRecord: boolean;
}

export const DEFAULT_SMART_MONEY_TOP_TRADER_ID: string;
export const DEFAULT_SMART_MONEY_LEAD_PORTFOLIO_ID: string;
export const DEFAULT_SMART_MONEY_PROFILE_ID: string;
export const DEFAULT_SMART_MONEY_SOURCE_URL: string;

export function extractSmartMoneyProfileId(input: unknown): string;
export function normalizeSmartMoneyProfileSnapshot(
  input: unknown,
  options?: { topTraderId?: string; fetchedAt?: string | number },
): SmartMoneyProfileSnapshot;
export function createSmartMoneyTradeProfile(
  existingProfiles: unknown,
  snapshot: SmartMoneyProfileSnapshot | unknown,
  now?: number,
): TradeProfile;
export function upsertSmartMoneyTradeProfile(
  existingProfiles: unknown,
  snapshot: SmartMoneyProfileSnapshot,
  now?: number,
): { profiles: TradeProfile[]; profile: TradeProfile; created: boolean };
export function normalizeSmartMoneySourceConfig(
  value: unknown,
  options?: { legacyMonitor?: unknown },
): SmartMoneySourceConfig | null;
export function smartMoneyTradeProfileId(topTraderId: unknown): string;
