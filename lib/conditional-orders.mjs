import { getTradeCloseTime } from "./performance.mjs";

const DATE_PATTERN = /(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/;
const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 从 OCR 单词坐标中按日期行锚点解析条件单历史。
 * 主要兼容 Tesseract.js v7 的 { text, confidence, bbox: { x0, y0, x1, y1 } }。
 */
export function parseConditionOrdersFromOcrWords(words, imageWidth) {
  if (!Array.isArray(words)) {
    throw new TypeError("OCR 单词必须是数组");
  }
  const normalizedWidth = positiveFiniteNumber(imageWidth, "截图宽度");
  const normalizedWords = words
    .map((word, index) => normalizeOcrWord(word, index, normalizedWidth))
    .filter((word) => word !== null);
  const anchors = findRowAnchors(normalizedWords);
  const rowCandidates = [];
  const byId = new Map();

  for (const [index, anchor] of anchors.entries()) {
    const previous = anchors[index - 1];
    const next = anchors[index + 1];
    const defaultRange = Math.max(36, anchor.height * 3);
    const top = previous
      ? (previous.centerY + anchor.centerY) / 2
      : anchor.centerY - (next
          ? Math.max(24, (next.centerY - anchor.centerY) / 2)
          : defaultRange);
    const bottom = next
      ? (anchor.centerY + next.centerY) / 2
      : anchor.centerY + (previous
          ? Math.max(24, (anchor.centerY - previous.centerY) / 2)
          : defaultRange);
    const rowWords = normalizedWords
      .filter((word) => word.centerY >= top && word.centerY < bottom)
      .sort(compareOcrColumns);
    const createdTime = parseCreatedTime(rowWords);
    if (!createdTime) continue;
    const rawText = rowWords.map((word) => word.text).join(" ");
    rowCandidates.push({
      rowWords,
      createdTime,
      symbol: parseSymbol(rawText, rowWords),
    });
  }

  const parsedRows = rowCandidates.map((candidate) =>
    parseConditionOrderRow(candidate.rowWords, candidate.createdTime),
  );
  for (const [index, candidate] of rowCandidates.entries()) {
    if (parsedRows[index] || !candidate.symbol) continue;
    const candidateTime = Date.parse(candidate.createdTime);
    const nearby = parsedRows
      .filter((order) =>
        order &&
        order.symbol === candidate.symbol &&
        Math.abs(Date.parse(order.createdTime) - candidateTime) <= 15 * 60 * 1000,
      )
      .sort((left, right) =>
        Math.abs(Date.parse(left.createdTime) - candidateTime) -
        Math.abs(Date.parse(right.createdTime) - candidateTime),
      )[0];
    if (!nearby) continue;
    parsedRows[index] = parseConditionOrderRow(
      candidate.rowWords,
      candidate.createdTime,
      nearby.closeSide,
    );
  }

  for (const order of parsedRows) {
    if (!order) continue;
    byId.delete(order.id);
    byId.set(order.id, order);
  }

  return [...byId.values()].sort((left, right) => {
    const timeDifference = Date.parse(left.createdTime) - Date.parse(right.createdTime);
    return timeDifference || compareStrings(left.id, right.id);
  });
}

/**
 * 将 OCR 条件单挂接到对应交易，并生成可供回放使用的动态 riskLevels。
 */
export function attachConditionOrdersToTrades(trades, orders) {
  if (!Array.isArray(trades)) {
    throw new TypeError("交易记录必须是数组");
  }
  if (!Array.isArray(orders)) {
    throw new TypeError("条件单记录必须是数组");
  }

  const tradeWindows = trades.map((trade, index) => createTradeWindow(trade, index));
  const matchedByTradeIndex = new Map();
  const uniqueOrders = new Map();

  for (const order of orders) {
    if (!isRecord(order) || typeof order.id !== "string" || !order.id.trim()) {
      continue;
    }
    uniqueOrders.delete(order.id);
    uniqueOrders.set(order.id, order);
  }

  for (const order of uniqueOrders.values()) {
    const orderTime = timestampOrNull(order.createdTime);
    if (orderTime === null) continue;
    const orderSymbol = normalizeSymbol(order.symbol);
    const candidates = tradeWindows
      .filter((window) =>
        window &&
        window.symbol === orderSymbol &&
        window.closeSide === order.closeSide &&
        orderTime >= window.entryTime &&
        orderTime <= window.exitTime,
      )
      .sort((left, right) => right.entryTime - left.entryTime);
    const matchedWindow = candidates[0];
    if (!matchedWindow) continue;

    const matched = matchedByTradeIndex.get(matchedWindow.index) ?? [];
    matched.push(order);
    matchedByTradeIndex.set(matchedWindow.index, matched);
  }

  return trades.map((trade, index) => {
    const matchedOrders = matchedByTradeIndex.get(index);
    const window = tradeWindows[index];
    if (!matchedOrders || matchedOrders.length === 0 || !window) return trade;

    matchedOrders.sort(compareConditionOrders);
    const generated = matchedOrders.map((order, orderIndex) => {
      const nextSameKind = matchedOrders
        .slice(orderIndex + 1)
        .find((candidate) => candidate.kind === order.kind);
      const endTime = nextSameKind?.createdTime ?? new Date(window.exitTime).toISOString();
      return conditionOrderToRiskLevel(order, endTime);
    });

    const merged = new Map();
    if (Array.isArray(trade.riskLevels)) {
      for (const level of trade.riskLevels) {
        if (!isRecord(level) || typeof level.id !== "string") continue;
        merged.set(level.id, level);
      }
    } else {
      for (const level of materializeStaticRiskLevels(trade, matchedOrders, window)) {
        merged.set(level.id, level);
      }
    }
    for (const level of generated) {
      merged.set(level.id, level);
    }

    return {
      ...trade,
      riskLevels: normalizeOcrRiskIntervals(
        [...merged.values()].sort(compareRiskLevels),
        window.exitTime,
      ),
    };
  });
}

function materializeStaticRiskLevels(trade, matchedOrders, window) {
  const levels = [];
  const startTime = new Date(window.entryTime).toISOString();
  const finalExitTime = new Date(window.exitTime).toISOString();
  for (const [field, kind, id] of [
    ["takeProfit", "takeProfit", "legacy-static-take-profit"],
    ["stopLoss", "stopLoss", "legacy-static-stop-loss"],
  ]) {
    const price = Number(trade[field]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const replacement = matchedOrders.find((order) => order.kind === kind);
    levels.push({
      id,
      kind,
      price,
      startTime,
      endTime: replacement?.createdTime ?? finalExitTime,
    });
  }
  return levels;
}

function normalizeOcrRiskIntervals(levels, exitTime) {
  const finalExitTime = new Date(exitTime).toISOString();
  return levels.map((level, index) => {
    if (level.source !== "ocr") return level;
    const nextSameKind = levels
      .slice(index + 1)
      .find((candidate) =>
        candidate.source === "ocr" && candidate.kind === level.kind,
      );
    return {
      ...level,
      endTime: nextSameKind?.startTime ?? finalExitTime,
    };
  });
}

function normalizeOcrWord(word, index, imageWidth) {
  if (!isRecord(word)) return null;
  const text = typeof word.text === "string"
    ? normalizeOcrText(word.text)
    : "";
  if (!text) return null;

  const box = ocrBox(word);
  if (!box) return null;
  const { x0, y0, x1, y1 } = box;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 < x0 || y1 < y0) {
    return null;
  }

  const confidence = finiteNumberOrNull(word.confidence);
  return {
    index,
    text,
    confidence: confidence === null ? null : Math.max(0, Math.min(100, confidence)),
    x0,
    y0,
    x1,
    y1,
    centerX: (x0 + x1) / 2,
    centerY: (y0 + y1) / 2,
    xRatio: ((x0 + x1) / 2) / imageWidth,
    height: Math.max(1, y1 - y0),
  };
}

function normalizeOcrText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|\s)\(026(?=[./-]\d{1,2}[./-]\d{1,2})/g, "$12026");
}

function ocrBox(word) {
  if (isRecord(word.bbox)) {
    return {
      x0: Number(word.bbox.x0),
      y0: Number(word.bbox.y0),
      x1: Number(word.bbox.x1),
      y1: Number(word.bbox.y1),
    };
  }
  if (isRecord(word.boundingBox)) {
    const x = Number(word.boundingBox.x);
    const y = Number(word.boundingBox.y);
    return {
      x0: x,
      y0: y,
      x1: x + Number(word.boundingBox.width),
      y1: y + Number(word.boundingBox.height),
    };
  }
  if ([word.x, word.y, word.width, word.height].every((value) =>
    Number.isFinite(Number(value)),
  )) {
    const x = Number(word.x);
    const y = Number(word.y);
    return {
      x0: x,
      y0: y,
      x1: x + Number(word.width),
      y1: y + Number(word.height),
    };
  }
  return null;
}

function findRowAnchors(words) {
  const typicalHeight = median(words.map((word) => word.height)) ?? 16;
  const sameRowTolerance = Math.max(24, typicalHeight * 2.5);
  const anchors = words
    .filter((word) => symbolToken(word.text) !== null)
    .map((word) => ({
      centerY: word.centerY,
      centerX: word.centerX,
      height: word.height,
      source: "symbol",
    }))
    .sort(compareRowAnchors);

  for (const word of words) {
    if (!DATE_PATTERN.test(word.text)) continue;
    const nearby = anchors.find(
      (anchor) => Math.abs(anchor.centerY - word.centerY) <= sameRowTolerance,
    );
    if (nearby) {
      nearby.height = Math.max(nearby.height, word.height);
      continue;
    }
    anchors.push({
      centerY: word.centerY,
      centerX: word.centerX,
      height: word.height,
      source: "date",
    });
  }

  anchors.sort(compareRowAnchors);
  return anchors.filter((anchor, index) =>
    index === 0 ||
    Math.abs(anchor.centerY - anchors[index - 1].centerY) > sameRowTolerance,
  );
}

function parseCreatedTime(rowWords) {
  const dateWords = rowWords.filter((word) => DATE_PATTERN.test(word.text));
  for (const dateWord of dateWords) {
    const dateMatch = DATE_PATTERN.exec(dateWord.text);
    if (!dateMatch) continue;
    const inlineTail = dateWord.text.slice((dateMatch.index ?? 0) + dateMatch[0].length);
    const inlineTime = findTimeParts(inlineTail);
    const timeWord = inlineTime ? null : rowWords
      .filter((candidate) =>
        candidate !== dateWord && candidate.centerX >= dateWord.centerX,
      )
      .sort((left, right) => left.centerX - right.centerX)
      .find((candidate) => findTimeParts(candidate.text));
    const timeParts = inlineTime ?? (timeWord ? findTimeParts(timeWord.text) : null);
    if (!timeParts) continue;
    const createdTime = utc8DateTimeToIso({
      year: Number(dateMatch[1]),
      month: Number(dateMatch[2]),
      day: Number(dateMatch[3]),
      hour: timeParts.hour,
      minute: timeParts.minute,
      second: timeParts.second,
    });
    if (createdTime) return createdTime;
  }
  return null;
}

function findTimeParts(text) {
  const normalized = String(text).trim().replace(/^[^\d]+|[^\d]+$/g, "");
  const match = normalized.match(
    /^([01]?\d|2[0-3])\D+([0-6]?\d)(?:\D+([0-6]?\d))?$/,
  );
  if (!match) return null;
  return {
    hour: Number(match[1]),
    minute: normalizeOcrClockPart(match[2]),
    second: normalizeOcrClockPart(match[3] ?? 0),
  };
}

function normalizeOcrClockPart(value) {
  const number = Number(value);
  return number >= 60 && number <= 69 ? number - 10 : number;
}

function utc8DateTimeToIso(parts) {
  const utcTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - UTC_8_OFFSET_MS;
  const verification = new Date(utcTime + UTC_8_OFFSET_MS);
  if (
    verification.getUTCFullYear() !== parts.year ||
    verification.getUTCMonth() + 1 !== parts.month ||
    verification.getUTCDate() !== parts.day ||
    verification.getUTCHours() !== parts.hour ||
    verification.getUTCMinutes() !== parts.minute ||
    verification.getUTCSeconds() !== parts.second
  ) {
    return null;
  }
  return new Date(utcTime).toISOString();
}

function parseConditionOrderRow(rowWords, createdTime, fallbackCloseSide = null) {
  const rawText = rowWords.map((word) => word.text).join(" ");
  const symbol = parseSymbol(rawText, rowWords);
  if (!symbol) return null;
  const asset = symbol.replace(/(?:USDT|USDC|BUSD)$/i, "");
  const trigger = parseTrigger(rawText);
  const explicitCloseSide = parseCloseSide(rawText);
  let closeSide = explicitCloseSide ?? fallbackCloseSide;
  let kind = trigger
    ? parseConditionKind(
        rawText,
        closeSide,
        trigger.comparator,
        fallbackCloseSide !== null && explicitCloseSide === null,
      )
    : null;
  if (!closeSide && kind && trigger) {
    closeSide = inferCloseSide(kind, trigger.comparator);
  }
  if (!kind && closeSide && trigger) {
    kind = parseConditionKind(rawText, closeSide, trigger.comparator);
  }
  const executionType = parseExecutionType(rawText);
  const quantity = parseQuantity(rawText, asset);
  if (
    !closeSide ||
    !kind ||
    !executionType ||
    !trigger ||
    quantity === null
  ) {
    return null;
  }

  const status = parseOcrStatus(rawText);
  const confidence = averageConfidence(rowWords);
  const semanticKey = [
    symbol,
    createdTime,
    closeSide,
    kind,
    executionType,
    trigger.comparator,
    canonicalNumber(trigger.price),
    canonicalNumber(quantity),
  ].join("|");

  return {
    id: `ocr-condition-${stableHash(semanticKey)}`,
    symbol,
    createdTime,
    closeSide,
    kind,
    executionType,
    triggerPrice: trigger.price,
    comparator: trigger.comparator,
    quantity,
    asset,
    status,
    confidence,
    rawText,
  };
}

function parseSymbol(rawText, words) {
  for (const word of words) {
    const compact = word.text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (/^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/.test(compact)) return compact;
  }
  const match = rawText.toUpperCase().match(/\b([A-Z0-9]{2,})\s*[\/_-]?\s*(USDT|USDC|BUSD)\b/);
  return match ? `${match[1]}${match[2]}` : null;
}

function parseCloseSide(rawText) {
  const compact = rawText.replace(/\s+/g, "").toLowerCase();
  if (/平多|关闭?多仓|closelong/.test(compact)) return "closeLong";
  if (/平空|关闭?空仓|closeshort/.test(compact)) return "closeShort";
  return null;
}

function parseConditionKind(
  rawText,
  closeSide,
  comparator,
  allowComparatorFallback = false,
) {
  const compact = rawText.replace(/\s+/g, "").toUpperCase();
  const hasTakeProfit = /止盈|TAKEPROFIT|\bTP\b/.test(compact);
  const hasStopLoss = /止损|STOPLOSS|\bSL\b/.test(compact);
  if (hasTakeProfit && !hasStopLoss) return "takeProfit";
  if (hasStopLoss && !hasTakeProfit) return "stopLoss";
  if (/\bHER[EI]\b/.test(rawText.toUpperCase())) return "stopLoss";
  if (hasTakeProfit && hasStopLoss && !closeSide) return "stopLoss";
  if (!hasTakeProfit && !hasStopLoss && !/止|TAKE|STOP|\bTP\b|\bSL\b/.test(compact)) {
    return allowComparatorFallback && closeSide
      ? inferConditionKind(closeSide, comparator)
      : null;
  }

  return closeSide ? inferConditionKind(closeSide, comparator) : null;
}

function inferConditionKind(closeSide, comparator) {
  if (closeSide === "closeLong") {
    return comparator === "<=" ? "stopLoss" : "takeProfit";
  }
  return comparator === ">=" ? "stopLoss" : "takeProfit";
}

function inferCloseSide(kind, comparator) {
  if (kind === "stopLoss") {
    return comparator === "<=" ? "closeLong" : "closeShort";
  }
  return comparator === ">=" ? "closeLong" : "closeShort";
}

function parseExecutionType(rawText) {
  const compact = rawText.replace(/\s+/g, "").toUpperCase();
  if (/限价|LIMIT/.test(compact)) return "limit";
  if (/市价|MARKET/.test(compact)) return "market";
  return null;
}

function parseTrigger(rawText) {
  const normalized = rawText
    .replace(/[≤⩽]/g, "<=")
    .replace(/[≥⩾]/g, ">=")
    .replace(/<\s*[=-]+/g, "<=")
    .replace(/>\s*[=-]+/g, ">=")
    .replace(/<\s*=/g, "<=")
    .replace(/>\s*=/g, ">=");
  let match = normalized.match(/(<=|>=)\s*[:：]?\s*([0-9][0-9,.-]*)/);
  if (match) {
    const price = parsePositiveNumber(match[2]);
    return price === null ? null : { comparator: match[1], price };
  }
  match = normalized.match(/([0-9][0-9,.-]*)\s*(<=|>=)/);
  if (!match) return null;
  const price = parsePositiveNumber(match[1]);
  return price === null ? null : { comparator: match[2], price };
}

function parseQuantity(rawText, asset) {
  if (!asset) return null;
  const escapedAsset = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rawText.match(
    new RegExp(`([0-9][0-9,.-]*)\\s*${escapedAsset}(?![A-Z0-9])`, "i"),
  );
  if (match) return parseNonNegativeNumber(match[1]);
  const letterZero = rawText.match(
    new RegExp(`(?:^|[^A-Z0-9])O\\s*${escapedAsset}(?![A-Z0-9])`, "i"),
  );
  return letterZero ? 0 : null;
}

function parseOcrStatus(rawText) {
  const compact = rawText.replace(/\s+/g, "").toUpperCase();
  if (/已取消|已撤销|撤单|CANCELLED|CANCELED/.test(compact)) return "cancelled";
  if (/已过期|过期|EXPIRED/.test(compact)) return "expired";
  if (/已触发|触发成功|已成交|已执行|已完成|FILLED|EXECUTED|COMPLETED/.test(compact)) {
    return "filled";
  }
  return "unknown";
}

function averageConfidence(words) {
  const values = words
    .map((word) => word.confidence)
    .filter((confidence) => confidence !== null);
  if (values.length === 0) return 0;
  return cleanNumber(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function createTradeWindow(trade, index) {
  if (!isRecord(trade)) return null;
  const entryTime = timestampOrNull(trade.entryTime);
  const exitTime = getTradeCloseTime(trade);
  const symbol = normalizeSymbol(trade.symbol);
  const closeSide = tradeCloseSide(trade.side);
  if (entryTime === null || exitTime === null || !symbol || !closeSide || exitTime < entryTime) {
    return null;
  }
  return { index, entryTime, exitTime, symbol, closeSide };
}

function tradeCloseSide(side) {
  const normalized = String(side ?? "").trim().toLowerCase();
  if (["long", "buy", "多", "做多"].includes(normalized)) return "closeLong";
  if (["short", "sell", "空", "做空"].includes(normalized)) return "closeShort";
  return null;
}

function conditionOrderToRiskLevel(order, endTime) {
  const endState = conditionEndState(order.status);
  return {
    id: `ocr-risk-${order.id}`,
    kind: order.kind,
    price: Number(order.triggerPrice),
    startTime: order.createdTime,
    endTime,
    ...(endState ? { endState } : {}),
    executionType: order.executionType,
    source: "ocr",
    ocrStatus: order.status,
    comparator: order.comparator,
    quantity: Number(order.quantity),
    asset: order.asset,
    confidence: Number(order.confidence),
    rawText: order.rawText,
  };
}

function conditionEndState(status) {
  if (status === "filled" || status === "cancelled" || status === "expired") {
    return status;
  }
  return null;
}

function compareConditionOrders(left, right) {
  const timeDifference = Date.parse(left.createdTime) - Date.parse(right.createdTime);
  return timeDifference || compareStrings(left.id, right.id);
}

function compareRiskLevels(left, right) {
  const leftTime = timestampOrNull(left.startTime) ?? Number.POSITIVE_INFINITY;
  const rightTime = timestampOrNull(right.startTime) ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime || compareStrings(String(left.id), String(right.id));
}

function compareOcrColumns(left, right) {
  return left.xRatio - right.xRatio || left.centerY - right.centerY || left.index - right.index;
}

function compareRowAnchors(left, right) {
  return left.centerY - right.centerY || left.centerX - right.centerX;
}

function symbolToken(value) {
  const compact = String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/.test(compact) ? compact : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function normalizeSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function timestampOrNull(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parsePositiveNumber(value) {
  const number = Number(normalizeOcrNumber(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseNonNegativeNumber(value) {
  const number = Number(normalizeOcrNumber(value));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeOcrNumber(value) {
  let normalized = String(value)
    .replace(/,/g, "")
    .replace(/(\d)-(?=\d{3,}(?:\D|$))/g, "$1.");
  const dotParts = normalized.split(".");
  if (dotParts.length > 2) {
    normalized = `${dotParts.slice(0, -1).join("")}.${dotParts.at(-1)}`;
  }
  return normalized;
}

function positiveFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return number;
}

function finiteNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalNumber(value) {
  return Number(value).toString();
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanNumber(value) {
  const cleaned = Number(value.toFixed(6));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}
