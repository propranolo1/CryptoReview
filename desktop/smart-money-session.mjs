const BINANCE_LATEST_RECORDS_API =
  "https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/query-order-history";
const BINANCE_CURRENT_POSITIONS_API =
  "https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/query-positions";
const TOP_TRADER_ID_PATTERN = /^\d{12,24}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{4,30}$/;
const LATEST_RECORD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 10;
const POSITION_PAGE_SIZE = 9;
const MAX_PAGES = 100;

export function isAllowedBinanceNavigation(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (hostname === "binance.com" || hostname.endsWith(".binance.com"))
    );
  } catch {
    return false;
  }
}

export function createSmartMoneySessionService({
  browserSession,
  BrowserWindow,
  now = () => Date.now(),
}) {
  if (!browserSession || typeof browserSession.fetch !== "function") {
    throw new TypeError("Binance 网页会话不可用");
  }
  if (typeof BrowserWindow !== "function") {
    throw new TypeError("Binance 登录窗口不可用");
  }
  browserSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => {
    callback(false);
  });
  browserSession.setPermissionCheckHandler?.(() => false);

  let loginWindow = null;
  let loginPromise = null;

  const authorize = ({ sourceUrl, topTraderId: inputTopTraderId } = {}) => {
    const topTraderId = requireTopTraderId(inputTopTraderId ?? sourceUrl);
    const targetUrl = normalizeProfileUrl(sourceUrl, topTraderId);
    if (loginWindow && !loginWindow.isDestroyed?.()) {
      loginWindow.focus?.();
      return loginPromise;
    }

    loginPromise = new Promise((resolve, reject) => {
      const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 960,
        minHeight: 680,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#0b0e11",
        title: "Binance 登录 · CryptoReview",
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
          session: browserSession,
        },
      });
      loginWindow = window;
      const contents = window.webContents;
      const guardNavigation = (event, url) => {
        if (!isAllowedBinanceNavigation(url)) event.preventDefault();
      };
      contents.on("will-navigate", guardNavigation);
      contents.on("will-redirect", guardNavigation);
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.once("ready-to-show", () => window.show());
      window.once("closed", () => {
        loginWindow = null;
        loginPromise = null;
        resolve({ completed: true });
      });
      Promise.resolve(window.loadURL(targetUrl)).catch((error) => {
        loginWindow = null;
        loginPromise = null;
        window.destroy?.();
        reject(new Error(
          error instanceof Error && error.message
            ? `Binance 登录页面打开失败：${error.message}`
            : "Binance 登录页面打开失败。",
        ));
      });
    });
    return loginPromise;
  };

  const syncLatestRecords = async ({
    topTraderId: inputTopTraderId,
    includePositions: inputIncludePositions = true,
    includeLatestRecords: inputIncludeLatestRecords = true,
  } = {}) => {
    const topTraderId = requireTopTraderId(inputTopTraderId);
    const includePositions = inputIncludePositions !== false;
    const includeLatestRecords = inputIncludeLatestRecords !== false;
    const endTime = Math.floor(now());
    if (!Number.isSafeInteger(endTime) || endTime <= 0) {
      throw new TypeError("本机时间无效，无法读取 Binance 聪明钱数据");
    }
    const startTime = endTime - LATEST_RECORD_WINDOW_MS;
    const positionsByKey = new Map();
    const recordsByKey = new Map();
    let positionsTruncated = false;
    let page = 1;
    let truncated = false;

    if (includePositions) {
      for (let positionPage = 1; positionPage <= MAX_PAGES; positionPage += 1) {
        const url = new URL(BINANCE_CURRENT_POSITIONS_API);
        url.searchParams.set("topTraderId", topTraderId);
        url.searchParams.set("marketType", "UM");
        url.searchParams.set("rows", String(POSITION_PAGE_SIZE));
        url.searchParams.set("page", String(positionPage));
        const response = await browserSession.fetch(url.toString(), {
          method: "GET",
          credentials: "include",
          useSessionCookies: true,
          headers: {
            Accept: "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            Clienttype: "web",
            Referer: profileUrl(topTraderId),
          },
        });

        if (response.status === 401 || response.status === 403) {
          return authorizationRequiredResult();
        }
        if (!response.ok) {
          throw new Error(`Binance 当前仓位接口返回 ${response.status}，请稍后重试。`);
        }
        const payload = await response.json().catch(() => null);
        if (isAuthorizationPayload(payload)) return authorizationRequiredResult();
        if (isFailedPayload(payload)) {
          throw new Error(formatBinanceMessage(payload));
        }
        const rawPositions = extractRecordRows(payload);
        for (const rawPosition of rawPositions) {
          const position = normalizeCurrentPosition(rawPosition);
          if (position) positionsByKey.set(stablePositionKey(position), position);
        }
        if (rawPositions.length < POSITION_PAGE_SIZE) break;
        if (positionPage === MAX_PAGES) positionsTruncated = true;
      }
    }

    if (includeLatestRecords) {
      for (; page <= MAX_PAGES; page += 1) {
        const url = new URL(BINANCE_LATEST_RECORDS_API);
        url.searchParams.set("topTraderId", topTraderId);
        url.searchParams.set("marketType", "UM");
        url.searchParams.set("startTime", String(startTime));
        url.searchParams.set("endTime", String(endTime));
        url.searchParams.set("rows", String(PAGE_SIZE));
        url.searchParams.set("page", String(page));
        const response = await browserSession.fetch(url.toString(), {
          method: "GET",
          credentials: "include",
          useSessionCookies: true,
          headers: {
            Accept: "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
            Clienttype: "web",
            Referer: profileUrl(topTraderId),
          },
        });

        if (response.status === 401 || response.status === 403) {
          return authorizationRequiredResult();
        }
        if (!response.ok) {
          throw new Error(`Binance 最新操作记录接口返回 ${response.status}，请稍后重试。`);
        }
        const payload = await response.json().catch(() => null);
        if (isAuthorizationPayload(payload)) return authorizationRequiredResult();
        if (isFailedPayload(payload)) {
          throw new Error(formatBinanceMessage(payload));
        }
        const rawRecords = extractRecordRows(payload);
        for (const rawRecord of rawRecords) {
          const record = normalizeLatestRecord(rawRecord);
          if (record) recordsByKey.set(stableRecordKey(record), record);
        }
        if (rawRecords.length < PAGE_SIZE) break;
        if (page === MAX_PAGES) truncated = true;
      }
    }

    const records = [...recordsByKey.values()].sort(
      (left, right) => left.updateTime - right.updateTime ||
        stableRecordKey(left).localeCompare(stableRecordKey(right)),
    );
    const positions = [...positionsByKey.values()].sort((left, right) =>
      stablePositionKey(left).localeCompare(stablePositionKey(right)),
    );
    return {
      authorizationRequired: false,
      marketType: "UM",
      startTime,
      endTime,
      fetchedAt: new Date(endTime).toISOString(),
      positions,
      records,
      total: records.length,
      truncated,
      warnings: [
        ...(includeLatestRecords ? [
          "Binance 聪明钱最新操作记录仅覆盖最近 30 天，缺少更早开仓时无法重建完整交易。",
          "最新操作记录不提供手续费，复盘手续费按未知处理。",
        ] : []),
        ...(positionsTruncated ? ["当前仓位超过 900 条，本次只读取前 900 条。"] : []),
        ...(truncated ? ["最新操作记录超过 1,000 条，本次只读取前 1,000 条。"] : []),
      ],
    };
  };

  const dispose = async () => {
    if (loginWindow && !loginWindow.isDestroyed?.()) loginWindow.close?.();
    loginWindow = null;
    loginPromise = null;
    if (typeof browserSession.clearStorageData === "function") {
      await browserSession.clearStorageData();
    }
  };

  return { authorize, syncLatestRecords, dispose };
}

function normalizeCurrentPosition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const rawAmount = finiteNumber(value.positionAmount ?? value.amount ?? value.quantity);
  const entryPrice = finitePositiveNumber(value.entryPrice);
  if (
    !SYMBOL_PATTERN.test(symbol) ||
    rawAmount === null ||
    Math.abs(rawAmount) <= Number.EPSILON ||
    !entryPrice
  ) {
    return null;
  }
  const positionSide = normalizeCurrentPositionSide(
    value.positionSide ?? value.direction ?? value.side,
  );
  const positionAmount = positionSide === "BOTH" ? rawAmount : Math.abs(rawAmount);
  const breakEvenPrice = finitePositiveNumber(value.breakEvenPrice);
  const markPrice = finitePositiveNumber(value.markPrice) ?? entryPrice;
  const unrealizedProfit = finiteNumber(
    value.unrealizedProfit ?? value.unRealizedProfit ?? value.unrealizedPnl ?? value.pnl,
  ) ?? 0;
  return {
    symbol,
    positionAmount: cleanNumber(positionAmount),
    positionSide,
    entryPrice: cleanNumber(entryPrice),
    breakEvenPrice: breakEvenPrice ? cleanNumber(breakEvenPrice) : null,
    markPrice: cleanNumber(markPrice),
    unrealizedProfit: cleanNumber(unrealizedProfit),
    marginAsset: normalizeMarginAsset(
      value.marginAsset ?? value.collateral ?? value.asset,
      symbol,
    ),
  };
}

function normalizeLatestRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const side = String(value.side ?? "").trim().toUpperCase();
  const positionSide = normalizePositionSide(value.positionSide);
  const executedQty = finitePositiveNumber(
    value.executedQty ?? value.executedQuantity ?? value.quantity,
  );
  const executedQuoteQty = finiteNonNegativeNumber(
    value.executedQuoteQty ?? value.executedQuoteQuantity ?? value.quoteQuantity,
  );
  let avgPrice = finitePositiveNumber(value.avgPrice ?? value.averagePrice ?? value.price);
  if (!avgPrice && executedQty && executedQuoteQty) {
    avgPrice = executedQuoteQty / executedQty;
  }
  const updateTime = timestampNumber(value.updateTime ?? value.orderUpdateTime ?? value.time);
  if (
    !SYMBOL_PATTERN.test(symbol) ||
    (side !== "BUY" && side !== "SELL") ||
    !executedQty ||
    !avgPrice ||
    updateTime === null
  ) {
    return null;
  }
  return {
    symbol,
    side,
    positionSide,
    avgPrice: cleanNumber(avgPrice),
    executedQty: cleanNumber(executedQty),
    executedQuoteQty: cleanNumber(executedQuoteQty ?? executedQty * avgPrice),
    updateTime,
  };
}

function requireTopTraderId(value) {
  const text = String(value ?? "").trim();
  if (TOP_TRADER_ID_PATTERN.test(text)) return text;
  try {
    const url = new URL(text);
    if (!isAllowedBinanceNavigation(url.toString())) throw new Error();
    const match = /\/smart-money\/profile\/(\d{12,24})(?:\/|$)/i.exec(url.pathname);
    if (match) return match[1];
  } catch {
    // 统一返回不包含原始输入的受控错误。
  }
  throw new TypeError("Binance 聪明钱主页 ID 无效");
}

function normalizeProfileUrl(sourceUrl, topTraderId) {
  if (sourceUrl) {
    const url = new URL(String(sourceUrl).trim());
    if (
      isAllowedBinanceNavigation(url.toString()) &&
      requireTopTraderId(url.toString()) === topTraderId
    ) {
      return url.toString();
    }
  }
  return profileUrl(topTraderId);
}

function profileUrl(topTraderId) {
  return `https://www.binance.com/zh-CN/smart-money/profile/${topTraderId}`;
}

function extractRecordRows(payload) {
  let value = unwrapData(payload);
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    const candidate = value.data ?? value.list ?? value.rows ?? value.positions ?? value.orderHistory;
    if (candidate === value) return [];
    value = candidate;
  }
  return Array.isArray(value) ? value : [];
}

function unwrapData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value;
}

function isAuthorizationPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success !== false) return false;
  const message = String(payload.message ?? payload.messageDetail ?? "").toLowerCase();
  return /login|log in|unauthor|未登录|请登录|登录/.test(message);
}

function isFailedPayload(payload) {
  return !payload || typeof payload !== "object" || payload.success === false;
}

function authorizationRequiredResult() {
  return {
    authorizationRequired: true,
    message: "需要先在 Binance 登录窗口完成登录。",
  };
}

function formatBinanceMessage(payload) {
  const raw = payload && typeof payload === "object"
    ? payload.message ?? payload.messageDetail
    : null;
  const text = typeof raw === "string"
    ? raw.trim()
    : raw && typeof raw === "object"
      ? Object.values(raw).find((item) => typeof item === "string" && item.trim())
      : null;
  return typeof text === "string" && text.trim()
    ? text.trim().slice(0, 240)
    : "Binance 最新操作记录返回无效数据，请稍后重试。";
}

function normalizePositionSide(value) {
  const side = String(value ?? "BOTH").trim().toUpperCase();
  return side === "LONG" || side === "SHORT" ? side : "BOTH";
}

function normalizeCurrentPositionSide(value) {
  const side = String(value ?? "BOTH").trim().toUpperCase();
  if (side === "LONG" || side === "BUY") return "LONG";
  if (side === "SHORT" || side === "SELL") return "SHORT";
  return "BOTH";
}

function normalizeMarginAsset(value, symbol) {
  const asset = String(value ?? "").trim().toUpperCase();
  if (/^[A-Z0-9]{2,20}$/.test(asset)) return asset;
  for (const candidate of ["FDUSD", "USDT", "USDC"]) {
    if (symbol.endsWith(candidate)) return candidate;
  }
  return "USDT";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestampNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return Math.trunc(number < 10_000_000_000 ? number * 1000 : number);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableRecordKey(record) {
  return [
    record.symbol,
    record.side,
    record.positionSide,
    record.avgPrice,
    record.executedQty,
    record.executedQuoteQty,
    record.updateTime,
  ].join("\u0000");
}

function stablePositionKey(position) {
  return [position.symbol, position.positionSide].join("\u0000");
}

function cleanNumber(value) {
  return Number(Number(value).toPrecision(15));
}
