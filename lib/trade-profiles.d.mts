import type { CopyTradeMonitorConfig } from "./copy-trade-monitor.mjs";
import type { SmartMoneySourceConfig } from "./smart-money-profile.mjs";

export type ChartIndicatorKey =
  | "xinMentorship"
  | "ema21"
  | "ema200"
  | "volumeColoring"
  | "volume"
  | "openInterest"
  | "delta"
  | "cvd";

export type IndicatorPaneKey =
  | "xinMentorship"
  | "volume"
  | "openInterest"
  | "delta"
  | "cvd";

export interface TradeProfileChartPreferences {
  indicatorVisibility: Partial<Record<ChartIndicatorKey, boolean>>;
  indicatorPaneOrder: IndicatorPaneKey[];
}

export interface TradeProfile {
  id: string;
  name: string;
  createdAt: string;
  copyTradeMonitor?: CopyTradeMonitorConfig;
  smartMoneySource?: SmartMoneySourceConfig;
  chartPreferences?: TradeProfileChartPreferences;
}

export const DEFAULT_TRADE_PROFILE_ID: "profile-self";
export const XIAOHONG_TRADE_PROFILE_ID: "profile-xiaohong";
export const BINANCE_SMART_MONEY_PROFILE_ID: string;
export const CHART_INDICATOR_KEYS: readonly ChartIndicatorKey[];
export const DEFAULT_INDICATOR_PANE_ORDER: readonly IndicatorPaneKey[];
export function normalizeChartPreferences(input: unknown): TradeProfileChartPreferences | null;

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
export function resolveTradeProfileSelection(
  existingProfiles: unknown,
  profileId: unknown,
): TradeProfile;
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
