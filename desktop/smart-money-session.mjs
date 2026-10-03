import { createSmartMoneyPageSource } from "./smart-money-page-source.mjs";

const TOP_TRADER_ID_PATTERN = /^\d{12,24}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{4,30}$/;
const LATEST_RECORD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 100;

export function isAllowedBinanceNavigation(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      (hostname === "binance.com" || hostname.endsWith(".binance.com"));
  } catch { return false; }
}

export function createSmartMoneySessionService({
  browserSession, BrowserWindow, Menu, now = () => Date.now(),
  syncTimeoutMs = 30_000, authorizationTimeoutMs = 5 * 60_000, driveIntervalMs = 400,
}) {
  if (!browserSession || typeof BrowserWindow !== "function") {
    throw new TypeError("Binance 网页会话不可用");
  }
  browserSession.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler?.(() => false);
  let loginWindow = null;
  let operation = null;
  let disposing = false;
  let clearingSession = false;
  let activeSource = null;

  const createWindow = (interactive) => {
    if (loginWindow && !loginWindow.isDestroyed()) return loginWindow;
    const window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 960, minHeight: 680,
      show: interactive, backgroundColor: "#0b0e11",
      title: "Binance 登录与同步 · CryptoReview",
      webPreferences: {
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, backgroundThrottling: false, session: browserSession,
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
    window.on("page-title-updated", (event) => event.preventDefault());
    window.on("close", (event) => {
      if (!disposing && !operation) { event.preventDefault(); window.hide(); }
    });
    window.once("closed", () => {
      activeSource?.stop();
      loginWindow = null;
    });
    if (Menu) window.setMenu(Menu.buildFromTemplate([{
      label: "登录与同步",
      submenu: [
        { label: "重新打开聪明钱主页", click: () => {
          if (operation) return;
          const options = window.lastSyncOptions;
          if (options) void window.loadURL(profileUrl(options.topTraderId)).catch(() => window.setTitle("页面打开失败，请稍后重试 · CryptoReview"));
        } },
        { type: "separator" },
        { label: "退出登录并清除本机会话", click: () => void logout().catch(() => {
          if (!window.isDestroyed()) window.setTitle("清除登录失败，请稍后重试 · CryptoReview");
        }) },
        { label: "隐藏窗口并保留登录", click: () => window.hide() },
      ],
    }]));
    return window;
  };

  const begin = (options = {}, interactive) => {
    if (disposing || clearingSession) return Promise.reject(new Error("正在退出 Binance 会话，请稍后重试。"));
    const topTraderId = requireTopTraderId(options.topTraderId ?? options.sourceUrl);
    const includePositions = options.includePositions !== false;
    const includeLatestRecords = options.includeLatestRecords !== false;
    const key = JSON.stringify([topTraderId, includePositions, includeLatestRecords]);
    if (operation) {
      if (operation.key !== key) return Promise.reject(new Error("另一个聪明钱主页正在同步，请完成后再试。"));
      if (interactive) { loginWindow.show(); loginWindow.focus(); }
      return interactive ? operation.promise.then((syncResult) => ({ completed: true, syncResult })) : operation.promise;
    }
    const endTime = Math.floor(now());
    if (!Number.isSafeInteger(endTime) || endTime <= 0) throw new TypeError("本机时间无效，无法读取 Binance 聪明钱数据");
    const targetUrl = normalizeProfileUrl(options.sourceUrl, topTraderId);
    const window = createWindow(interactive);
    window.lastSyncOptions = { topTraderId, includePositions, includeLatestRecords };
    if (interactive) { window.show(); window.focus(); }
    window.setTitle?.(interactive ? "请完成 Binance 登录，随后自动同步 · CryptoReview" : "正在同步聪明钱 · CryptoReview");
    const currentOperation = { key };
    operation = currentOperation;
    currentOperation.promise = (async () => {
      let source;
      try {
        source = createSmartMoneyPageSource({
          window, topTraderId, timeoutMs: interactive ? authorizationTimeoutMs : syncTimeoutMs, driveIntervalMs,
        });
        activeSource = source;
        await source.open(targetUrl);
        const syncResult = await collectSmartMoneyData({
          source, topTraderId, includePositions, includeLatestRecords, endTime,
        });
        window.setTitle?.(syncResult.authorizationRequired ? "需要完成 Binance 登录 · CryptoReview" : "聪明钱同步完成 · CryptoReview");
        window.hide();
        return syncResult;
      } finally {
        source?.stop();
        if (activeSource === source) activeSource = null;
        if (operation === currentOperation) operation = null;
      }
    })();
    if (!interactive) return currentOperation.promise;
    return currentOperation.promise.then((syncResult) => ({ completed: true, syncResult })).catch((error) => {
      if (window.isDestroyed()) return { completed: false };
      window.setTitle?.("同步失败，可关闭窗口后重试 · CryptoReview");
      throw error;
    });
  };
  const authorize = (options) => begin(options, true);
  const syncLatestRecords = (options) => begin(options, false);
  const flush = async () => {
    browserSession.flushStorageData?.();
    await browserSession.cookies?.flushStore?.();
  };
  const logout = async () => {
    clearingSession = true;
    try {
      activeSource?.stop();
      loginWindow?.destroy();
      loginWindow = null;
      await browserSession.clearStorageData();
      await browserSession.clearCache?.();
      await flush();
      return { cleared: true };
    } finally { clearingSession = false; }
  };
  const dispose = async () => {
    disposing = true;
    activeSource?.stop();
    loginWindow?.destroy();
    loginWindow = null;
    await flush();
  };
  return { authorize, syncLatestRecords, logout, dispose };
}

async function collectSmartMoneyData({ source, includePositions, includeLatestRecords, endTime }) {
  const startTime = endTime - LATEST_RECORD_WINDOW_MS;
  const positionsByKey = new Map();
  const recordsByKey = new Map();
  let positionsTruncated = false;
  let truncated = false;
  for (const kind of ["positions", "order-history"]) {
    if (kind === "positions" ? !includePositions : !includeLatestRecords) continue;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await source.readPage(kind, page);
      if (response.status === 401) return authorizationRequiredResult();
      if (!response.ok) throw new Error(response.status === 429
        ? "Binance 请求过于频繁，请稍后重试；登录会话已保留。"
        : response.status === 403 ? "Binance 暂时拒绝数据访问，请在官网确认权限后重试。"
          : "Binance 官网数据暂时无法读取，请稍后重试。");
      const payload = response.payload;
      if (isAuthorizationPayload(payload)) return authorizationRequiredResult();
      if (isFailedPayload(payload)) throw new Error("Binance 官网返回无效数据，请稍后重试。");
      const rawRows = extractRecordRows(payload);
      if (!rawRows) throw new Error("Binance 官网数据结构已变化，本次未保存同步结果。");
      if (rawRows.length > 100) throw new Error("Binance 官网单页数据超出读取限制。");
      for (const row of rawRows) {
        if (kind === "positions") {
          const position = normalizeCurrentPosition(row);
          if (position) positionsByKey.set(stablePositionKey(position), position);
        } else {
          const record = normalizeLatestRecord(row);
          if (record && record.updateTime >= startTime && record.updateTime <= endTime) recordsByKey.set(stableRecordKey(record), record);
        }
      }
      const totalValue = payload.data?.total ?? payload.total;
      const total = totalValue == null || totalValue === "" ? NaN : Number(totalValue);
      if (rawRows.length < response.rows || (Number.isSafeInteger(total) && total >= 0 && page * response.rows >= total)) break;
      if (page === MAX_PAGES) {
        if (kind === "positions") positionsTruncated = true;
        else truncated = true;
      }
    }
  }
  const records = [...recordsByKey.values()].sort((a, b) => a.updateTime - b.updateTime || stableRecordKey(a).localeCompare(stableRecordKey(b)));
  const positions = [...positionsByKey.values()].sort((a, b) => stablePositionKey(a).localeCompare(stablePositionKey(b)));
  return {
    authorizationRequired: false, marketType: "UM", startTime, endTime,
    fetchedAt: new Date(endTime).toISOString(), positions, records, total: records.length, truncated,
    warnings: [
      ...(includeLatestRecords ? [
        "Binance 聪明钱最新操作记录仅覆盖最近 30 天，缺少更早开仓时无法重建完整交易。",
        "最新操作记录不提供手续费，复盘手续费按未知处理。",
      ] : []),
      ...(positionsTruncated ? ["官网当前仓位未读取完，本次结果已截断。"] : []),
      ...(truncated ? ["官网最新操作记录未读取完，本次结果已截断。"] : []),
    ],
  };
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
    if (requireTopTraderId(sourceUrl) !== topTraderId) throw new TypeError("Binance 聪明钱主页 ID 不一致");
  }
  // 固定到官网主页，不保留外部传入的登录回调或查询参数。
  return profileUrl(topTraderId);
}

function profileUrl(topTraderId) {
  return `https://www.binance.com/zh-CN/smart-money/profile/${topTraderId}`;
}

function extractRecordRows(payload) {
  let value = unwrapData(payload);
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return null;
    const candidate = value.data ?? value.list ?? value.rows ?? value.positions ?? value.orderHistory;
    if (candidate === value) return null;
    value = candidate;
  }
  return Array.isArray(value) ? value : null;
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
  return !payload || typeof payload !== "object" || Array.isArray(payload) || payload.success === false || (payload.code != null && String(payload.code) !== "000000" && String(payload.code) !== "0");
}

function authorizationRequiredResult() {
  return {
    authorizationRequired: true,
    message: "需要先在 Binance 登录窗口完成登录。",
  };
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
