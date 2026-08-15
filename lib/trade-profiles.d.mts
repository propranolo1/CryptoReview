import type { CopyTradeMonitorConfig } from "./copy-trade-monitor.mjs";
import type { SmartMoneySourceConfig } from "./smart-money-profile.mjs";

export interface TradeProfile {
  id: string;
  name: string;
  createdAt: string;
  copyTradeMonitor?: CopyTradeMonitorConfig;
  smartMoneySource?: SmartMoneySourceConfig;
}

export const DEFAULT_TRADE_PROFILE_ID: "profile-self";
export const XIAOHONG_TRADE_PROFILE_ID: "profile-xiaohong";
export const BINANCE_SMART_MONEY_PROFILE_ID: string;

export function normalizeTradeProfiles(input: unknown): TradeProfile[];
export function createTradeProfile(
  existingProfiles: unknown,
  name: string,
  now?: number,
): TradeProfile;
export function isProtectedTradeProfile(profileId: string): boolean;
export function removeTradeProfile(
  existingProfiles: unknown,
  profileId: string,
): TradeProfile[];
export function getTradeProfileId(record: unknown): string;
export function filterRecordsByTradeProfile<T>(
  records: readonly T[] | unknown,
  profileId: string,
): T[];
export function removeRecordsForTradeProfile<T>(
  records: readonly T[] | unknown,
  profileId: string,
): T[];
export function assignTradeProfile<T extends object>(
  records: readonly T[] | unknown,
  profile: TradeProfile,
  options?: { omitDefault?: boolean },
): Array<T & { profileId?: string; profileName?: string }>;
