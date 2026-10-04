import type { SmartMoneySourceConfig } from "./smart-money-profile.mjs";
import type { SmartMoneyTradeSnapshot } from "./copy-trade-monitor.mjs";

export function readSmartMoneyTradeSnapshot(
  source: SmartMoneySourceConfig,
  options?: {
    desktopApi?: Pick<CryptoReviewDesktopApi, "syncSmartMoneyLatestRecords" | "authorizeSmartMoney"> | null;
    fetchImpl?: typeof fetch;
    interactive?: boolean;
    fullHistory?: boolean;
    onAuthorizationRequired?: () => void;
  },
): Promise<{ snapshot: SmartMoneyTradeSnapshot; usingLatestRecords: boolean }>;
