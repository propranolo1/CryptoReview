const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;

const ACTIONS = Object.freeze({
  "开多": "openLong",
  "开启做多": "openLong",
  "平多": "closeLong",
  "关闭做多": "closeLong",
  "开空": "openShort",
  "开启做空": "openShort",
  "平空": "closeShort",
  "关闭做空": "closeShort",
});

/** 解析 Binance 跟单详情截图 OCR 文本中的开仓/平仓时间线。 */
export function parseFollowTradeTimelineText(input) {
  if (typeof input !== "string") {
    throw new TypeError("跟单记录 OCR 内容必须是文本");
  }
  const text = normalizeOcrText(input);
  if (!text) return [];

  const rows = [];
  const timestampPattern =
    /(?:^|\s)((?:20|2O|ZO)\d{2})[./-](\d{1,2})[./-](\d{1,2})\s+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/g;
  const matches = [...text.matchAll(timestampPattern)];
  for (const [index, match] of matches.entries()) {
    const blockStart = match.index + match[0].length;
    const blockEnd = matches[index + 1]?.index ?? text.length;
    const block = text.slice(blockStart, blockEnd).trim();
    const action = parseAction(block);
    const price = parseNumberAfter(block, /(?:以)?均价为\s*/);
    const symbol = parseSymbol(block);
    const quantity = parseNumberAfter(block, /成交数量为\s*/);
    if (!action || !symbol || price === null || quantity === null || quantity <= 0) continue;

    const year = Number(match[1].replace(/[OZ]/g, (character) => character === "O" ? "0" : "2"));
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] ?? 0);
    const time = utc8Timestamp(year, month, day, hour, minute, second);
    if (!time) continue;

    const quoteQuantity = parseNumberAfter(block, /总价值为\s*/);
    const realizedPnl = parseSignedNumberAfter(block, /已实现盈亏为\s*/);
    const id = `follow-${stableHash([
      time,
      action,
      symbol,
      price,
      quantity,
      quoteQuantity ?? "",
      realizedPnl ?? "",
    ].join("\u0000"))}`;
    rows.push({
      id,
      time,
      action,
      symbol,
      price,
      quantity,
      quoteQuantity: quoteQuantity ?? cleanNumber(price * quantity),
      realizedPnl: action.startsWith("close") ? realizedPnl : null,
    });
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.id, row);
  return [...unique.values()].sort((left, right) =>
    Date.parse(left.time) - Date.parse(right.time) ||
    left.id.localeCompare(right.id));
}

/** 将校对后的时间线事件保存为可跨多张截图稳定合并的订单档案。 */
export function createFollowTradeOrderRecords(events, { profileId, profileName }) {
  const normalizedProfileId = requiredText(profileId, "复盘用户 ID");
  const normalizedProfileName = requiredText(profileName, "复盘用户名");
  if (!Array.isArray(events)) throw new TypeError("跟单事件必须是数组");

  return events.map((event, index) => {
    validateEvent(event, index);
    const isLong = event.action.endsWith("Long");
    const isClose = event.action.startsWith("close");
    return {
      exchangeProvider: "binance-usdm",
      profileId: normalizedProfileId,
      profileName: normalizedProfileName,
      userId: `follow:${normalizedProfileId}`,
      orderId: event.id,
      symbol: event.symbol,
      orderType: "FOLLOW_EXECUTION",
      side: isLong === isClose ? "SELL" : "BUY",
      limitPrice: null,
      averagePrice: cleanNumber(event.price),
      originalQuantity: cleanNumber(event.quantity),
      executedQuantity: cleanNumber(event.quantity),
      executedQuoteQuantity: cleanNumber(
        Number(event.quoteQuantity) > 0
          ? Number(event.quoteQuantity)
          : event.price * event.quantity,
      ),
      stopPrice: null,
      status: "FILLED",
      createdAt: new Date(event.time).toISOString(),
      updatedAt: new Date(event.time).toISOString(),
      positionSide: isLong ? "LONG" : "SHORT",
      reduceOnly: isClose,
      source: "ocr-follow",
      syncSources: ["ocr-follow"],
      reportedRealizedPnl:
        isClose && Number.isFinite(Number(event.realizedPnl))
          ? cleanNumber(Number(event.realizedPnl))
          : null,
    };
  });
}

function normalizeOcrText(input) {
  return input
    .replace(/\u00a0/g, " ")
    .replace(/[，]/g, ",")
    .replace(/[。]/g, ".")
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAction(block) {
  const explicit = Object.keys(ACTIONS)
    .sort((left, right) => right.length - left.length)
    .find((label) => block.includes(label));
  return explicit ? ACTIONS[explicit] : null;
}

function parseSymbol(block) {
  const compact = block.toUpperCase().replace(/\s+/g, "");
  const phraseMatch = /(?:开启|关闭)做(?:多|空)([A-Z0-9]{2,}?(?:USDT|USDC|BUSD))/.exec(compact);
  if (phraseMatch) return phraseMatch[1];
  return /([A-Z0-9]{2,}?(?:USDT|USDC|BUSD))/.exec(compact)?.[1] ?? null;
}

function parseNumberAfter(block, prefix) {
  const match = new RegExp(`${prefix.source}([\\d,.]+)`, "i").exec(block);
  return match ? positiveNumber(match[1]) : null;
}

function parseSignedNumberAfter(block, prefix) {
  const match = new RegExp(`${prefix.source}([+\\-]?[\\d,.]+)`, "i").exec(block);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? cleanNumber(value) : null;
}

function positiveNumber(value) {
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? cleanNumber(number) : null;
}

function utc8Timestamp(year, month, day, hour, minute, second) {
  const time = Date.UTC(year, month - 1, day, hour, minute, second) - UTC_8_OFFSET_MS;
  const local = new Date(time + UTC_8_OFFSET_MS);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    return null;
  }
  return new Date(time).toISOString();
}

function validateEvent(event, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError(`第 ${index + 1} 条跟单事件无效`);
  }
  requiredText(event.id, `第 ${index + 1} 条事件 ID`);
  requiredText(event.symbol, `第 ${index + 1} 条交易对`);
  if (!Object.values(ACTIONS).includes(event.action)) {
    throw new TypeError(`第 ${index + 1} 条跟单方向无效`);
  }
  if (!Number.isFinite(Date.parse(event.time))) {
    throw new TypeError(`第 ${index + 1} 条跟单时间无效`);
  }
  if (!(Number(event.price) > 0) || !(Number(event.quantity) > 0)) {
    throw new TypeError(`第 ${index + 1} 条跟单成交数据无效`);
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}不能为空`);
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

function cleanNumber(value) {
  return Number(Number(value).toFixed(12));
}
