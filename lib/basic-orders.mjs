const DATE_PATTERN = /(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/;
const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;
const OCR_BASIC_USER_ID = "ocr-basic-local";

const COLUMN_RANGES = {
  orderType: [0.15, 0.255],
  direction: [0.255, 0.33],
  averagePrice: [0.33, 0.415],
  limitPrice: [0.415, 0.505],
  executedQuantity: [0.505, 0.59],
  originalQuantity: [0.59, 0.68],
  reduceOnly: [0.68, 0.755],
  postOnly: [0.755, 0.84],
  trigger: [0.84, 0.925],
  status: [0.925, 1.02],
};

/**
 * 从 Binance U 本位“基础单/订单历史”截图的 OCR 词元中解析订单。
 * 截图只提供委托时间，因此 createdAt 与 updatedAt 使用同一 UTC+8 时间。
 */
export function parseBasicOrdersFromOcrWords(words, imageWidth) {
  if (!Array.isArray(words)) throw new TypeError("OCR 单词必须是数组");
  const normalizedWidth = positiveFiniteNumber(imageWidth, "截图宽度");
  const normalizedWords = words
    .map((word, index) => normalizeOcrWord(word, index, normalizedWidth))
    .filter((word) => word !== null);
  const anchors = findRowAnchors(normalizedWords);
  const candidates = [];

  for (const [index, anchor] of anchors.entries()) {
    const previous = anchors[index - 1];
    const next = anchors[index + 1];
    const typicalRange = Math.max(36, anchor.height * 3);
    const top = previous
      ? (previous.centerY + anchor.centerY) / 2
      : anchor.centerY - (next
          ? Math.max(24, (next.centerY - anchor.centerY) / 2)
          : typicalRange);
    const bottom = next
      ? (anchor.centerY + next.centerY) / 2
      : anchor.centerY + (previous
          ? Math.max(24, (anchor.centerY - previous.centerY) / 2)
          : typicalRange);
    const rowWords = normalizedWords
      .filter((word) => word.centerY >= top && word.centerY < bottom)
      .sort(compareOcrColumns);
    const parsed = parseBasicOrderRow(rowWords);
    if (parsed) candidates.push(parsed);
  }

  repairMissingQuantityDecimals(candidates);
  inferMissingPositionActions(candidates);
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate.positionAction) continue;
    const order = createBasicOrderRecord(candidate);
    unique.delete(order.orderId);
    unique.set(order.orderId, order);
  }
  return [...unique.values()].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.orderId.localeCompare(right.orderId),
  );
}

/**
 * 将校对后的基础单字段转换为现有 Binance U 本位订单结构。
 * 订单号不包含状态、均价和成交数量，因此同一订单后续截图会更新原记录。
 */
export function createBasicOrderRecord(input) {
  if (!isRecord(input)) throw new TypeError("基础单必须是对象");
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) throw new TypeError("基础单交易对无效");
  const createdAt = normalizeIsoTime(input.createdAt, "基础单时间");
  const orderType = normalizeOrderType(input.orderType);
  const positionAction = normalizePositionAction(input.positionAction);
  const side = sideForPositionAction(positionAction);
  const limitPrice = nullablePositiveNumber(input.limitPrice, "委托价格");
  const averagePrice = nullablePositiveNumber(input.averagePrice, "成交均价");
  const executedQuantity = nonNegativeNumber(input.executedQuantity, "成交数量");
  const originalQuantity = nonNegativeNumber(input.originalQuantity, "委托数量");
  const reduceOnly = optionalBoolean(input.reduceOnly) ?? positionAction.startsWith("close");
  const postOnly = optionalBoolean(input.postOnly);
  const triggerConditionRaw = normalizeTriggerCondition(input.triggerConditionRaw);
  const status = normalizeStatus(input.status, executedQuantity);
  const triggeredByCondition = Boolean(
    input.triggeredByCondition ?? /条件|CONDITION/i.test(String(input.rawText ?? "")),
  );
  const identity = [
    OCR_BASIC_USER_ID,
    symbol,
    createdAt,
    positionAction,
    orderType,
    limitPrice === null ? "MARKET" : canonicalNumber(limitPrice),
    canonicalNumber(originalQuantity),
    reduceOnly ? "1" : "0",
    postOnly === null ? "?" : postOnly ? "1" : "0",
    triggerConditionRaw ?? "",
  ].join("|");

  return {
    userId: OCR_BASIC_USER_ID,
    orderId: `ocr-basic-${stableHash(identity)}`,
    symbol,
    orderType,
    side,
    limitPrice: orderType === "MARKET" ? null : limitPrice,
    averagePrice,
    originalQuantity,
    executedQuantity,
    executedQuoteQuantity:
      averagePrice === null ? 0 : averagePrice * executedQuantity,
    stopPrice: null,
    status,
    createdAt,
    updatedAt: createdAt,
    source: "ocr-basic",
    positionAction,
    reduceOnly,
    postOnly,
    triggeredByCondition,
    triggerConditionRaw,
    executionTimeKnown: false,
    confidence: confidenceNumber(input.confidence),
    rawText: String(input.rawText ?? "").trim(),
  };
}

/**
 * OCR 截图不含官方订单号；若能与已保存 CSV 订单唯一匹配，则保留 CSV 为权威来源，
 * 避免同一成交被 OCR 合成订单再次重建。
 */
export function reconcileBasicOrdersWithArchive(currentOrders, incomingOrders) {
  const current = Array.isArray(currentOrders) ? currentOrders : [];
  const incoming = Array.isArray(incomingOrders) ? incomingOrders : [];
  const newOrders = [];
  const matchedOfficialUserIds = new Set();
  let matchedExistingCount = 0;

  for (const order of incoming) {
    const matches = current.filter((existing) =>
      isRecord(existing) &&
      existing.source !== "ocr-basic" &&
      basicOrderMatchesOfficialOrder(order, existing),
    );
    if (matches.length === 1) {
      matchedExistingCount += 1;
      if (typeof matches[0].userId === "string" && matches[0].userId.trim()) {
        matchedOfficialUserIds.add(matches[0].userId);
      }
    } else {
      newOrders.push(order);
    }
  }
  const [matchedUserId] = matchedOfficialUserIds;
  const scopedNewOrders = matchedOfficialUserIds.size === 1
    ? newOrders.map((order) => ({ ...order, userId: matchedUserId }))
    : newOrders;
  return { newOrders: scopedNewOrders, matchedExistingCount };
}

function basicOrderMatchesOfficialOrder(basic, official) {
  if (!isRecord(basic) || !isRecord(official)) return false;
  if (normalizeSymbol(basic.symbol) !== normalizeSymbol(official.symbol)) return false;
  if (String(basic.side).toUpperCase() !== String(official.side).toUpperCase()) return false;
  if (normalizeOrderTypeForMatch(basic.orderType) !== normalizeOrderTypeForMatch(official.orderType)) {
    return false;
  }
  if (Date.parse(basic.createdAt) !== Date.parse(official.createdAt)) return false;
  if (!numbersNearlyEqual(basic.originalQuantity, official.originalQuantity)) return false;

  if (normalizeOrderTypeForMatch(basic.orderType) === "LIMIT") {
    if (!numbersNearlyEqual(basic.limitPrice, official.limitPrice)) return false;
  }
  return true;
}

function normalizeOrderTypeForMatch(value) {
  const text = String(value ?? "").toUpperCase();
  return text.includes("LIMIT") ? "LIMIT" : text.includes("MARKET") ? "MARKET" : text;
}

function numbersNearlyEqual(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  const scale = Math.max(1, Math.abs(leftNumber), Math.abs(rightNumber));
  return Math.abs(leftNumber - rightNumber) <= scale * 1e-9;
}

function parseBasicOrderRow(rowWords) {
  const createdAt = parseCreatedTime(rowWords);
  const symbol = parseSymbol(rowWords);
  if (!createdAt || !symbol) return null;
  const asset = symbol.replace(/(?:USDT|USDC|BUSD)$/i, "");
  const orderTypeText = columnText(rowWords, COLUMN_RANGES.orderType);
  const directionText = columnText(rowWords, COLUMN_RANGES.direction);
  const orderType = parseOrderType(orderTypeText);
  const positionAction = parsePositionAction(directionText);
  if (!orderType) return null;

  const average = parseNumericColumn(
    columnText(rowWords, COLUMN_RANGES.averagePrice),
  );
  const limit = parseNumericColumn(
    columnText(rowWords, COLUMN_RANGES.limitPrice),
  );
  const executed = parseQuantityColumn(
    columnText(rowWords, COLUMN_RANGES.executedQuantity),
    asset,
  );
  const original = parseQuantityColumn(
    columnText(rowWords, COLUMN_RANGES.originalQuantity),
    asset,
  );
  if (!executed || !original) return null;

  const rawText = rowWords.map((word) => word.text).join(" ");
  return {
    symbol,
    createdAt,
    orderType,
    positionAction,
    averagePrice: average?.value ?? null,
    limitPrice: orderType === "MARKET" ? null : limit?.value ?? null,
    executedQuantity: executed.value,
    originalQuantity: original.value,
    reduceOnly: parseBooleanColumn(
      columnText(rowWords, COLUMN_RANGES.reduceOnly),
    ),
    postOnly: parseBooleanColumn(
      columnText(rowWords, COLUMN_RANGES.postOnly),
    ),
    triggerConditionRaw: normalizeTriggerCondition(
      columnText(rowWords, COLUMN_RANGES.trigger),
    ),
    status: parseStatus(
      columnText(rowWords, COLUMN_RANGES.status),
      executed.value,
      original.value,
    ),
    triggeredByCondition: /条件|CONDITION/i.test(orderTypeText),
    confidence: averageConfidence(rowWords),
    rawText,
    asset,
    quantityMeta: { executed, original },
  };
}

function inferMissingPositionActions(candidates) {
  const chronological = [...candidates].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  for (const candidate of chronological) {
    if (candidate.positionAction || candidate.executedQuantity <= 0) continue;
    const candidateTime = Date.parse(candidate.createdAt);
    const sameSymbol = chronological.filter((other) =>
      other !== candidate &&
      other.symbol === candidate.symbol &&
      quantitiesMatch(other.executedQuantity, candidate.executedQuantity) &&
      other.positionAction,
    );
    const laterClose = sameSymbol
      .filter((other) =>
        Date.parse(other.createdAt) > candidateTime &&
        other.positionAction.startsWith("close"),
      )
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
    if (laterClose) {
      candidate.positionAction = laterClose.positionAction === "closeShort"
        ? "openShort"
        : "openLong";
      continue;
    }
    const earlierOpen = sameSymbol
      .filter((other) =>
        Date.parse(other.createdAt) < candidateTime &&
        other.positionAction.startsWith("open"),
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    if (earlierOpen && candidate.reduceOnly !== false) {
      candidate.positionAction = earlierOpen.positionAction === "openShort"
        ? "closeShort"
        : "closeLong";
    }
  }
}

function quantitiesMatch(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-6;
}

function repairMissingQuantityDecimals(candidates) {
  const precisionByAsset = new Map();
  for (const candidate of candidates) {
    for (const quantity of [
      candidate.quantityMeta.executed,
      candidate.quantityMeta.original,
    ]) {
      if (!quantity.hadDecimal || quantity.decimalPlaces <= 0) continue;
      const values = precisionByAsset.get(candidate.asset) ?? [];
      values.push(quantity.decimalPlaces);
      precisionByAsset.set(candidate.asset, values);
    }
  }

  for (const candidate of candidates) {
    const precisions = precisionByAsset.get(candidate.asset) ?? [];
    const precision = mode(precisions);
    if (!precision) continue;
    for (const field of ["executed", "original"]) {
      const quantity = candidate.quantityMeta[field];
      if (
        quantity.hadDecimal ||
        quantity.hadThousandsSeparator ||
        quantity.value <= 0 ||
        quantity.digitCount <= precision
      ) {
        continue;
      }
      const scaled = quantity.value / 10 ** precision;
      if (scaled >= 0.000001 && scaled < 10_000) {
        quantity.value = scaled;
        candidate[field === "executed" ? "executedQuantity" : "originalQuantity"] = scaled;
      }
    }
  }
}

function normalizeOcrWord(word, index, imageWidth) {
  if (!isRecord(word)) return null;
  const text = String(word.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const box = ocrBox(word);
  if (!box) return null;
  const { x0, y0, x1, y1 } = box;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 < x0 || y1 < y0) {
    return null;
  }
  const confidence = Number(word.confidence);
  return {
    index,
    text,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, confidence))
      : null,
    centerX: (x0 + x1) / 2,
    centerY: (y0 + y1) / 2,
    xRatio: ((x0 + x1) / 2) / imageWidth,
    height: Math.max(1, y1 - y0),
  };
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
  return null;
}

function findRowAnchors(words) {
  const typicalHeight = median(words.map((word) => word.height)) ?? 16;
  const tolerance = Math.max(24, typicalHeight * 2.5);
  const anchors = words
    .filter((word) => symbolToken(word.text))
    .map((word) => ({
      centerY: word.centerY,
      centerX: word.centerX,
      height: word.height,
    }))
    .sort(compareRowAnchors);

  for (const word of words) {
    if (!DATE_PATTERN.test(word.text)) continue;
    const nearby = anchors.find(
      (anchor) => Math.abs(anchor.centerY - word.centerY) <= tolerance,
    );
    if (nearby) {
      nearby.height = Math.max(nearby.height, word.height);
    } else {
      anchors.push({
        centerY: word.centerY,
        centerX: word.centerX,
        height: word.height,
      });
    }
  }

  anchors.sort(compareRowAnchors);
  return anchors.filter((anchor, index) =>
    index === 0 ||
    Math.abs(anchor.centerY - anchors[index - 1].centerY) > tolerance,
  );
}

function parseCreatedTime(words) {
  for (const dateWord of words.filter((word) => DATE_PATTERN.test(word.text))) {
    const match = DATE_PATTERN.exec(dateWord.text);
    if (!match) continue;
    const inline = findTimeParts(
      dateWord.text.slice((match.index ?? 0) + match[0].length),
    );
    const timeWord = inline ? null : words
      .filter((word) => word !== dateWord && word.centerX >= dateWord.centerX)
      .sort((left, right) => left.centerX - right.centerX)
      .find((word) => findTimeParts(word.text));
    const time = inline ?? (timeWord ? findTimeParts(timeWord.text) : null);
    if (!time) continue;
    const utc = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      time.hour,
      time.minute,
      time.second,
    ) - UTC_8_OFFSET_MS;
    const verification = new Date(utc + UTC_8_OFFSET_MS);
    if (
      verification.getUTCFullYear() === Number(match[1]) &&
      verification.getUTCMonth() === Number(match[2]) - 1 &&
      verification.getUTCDate() === Number(match[3]) &&
      verification.getUTCHours() === time.hour &&
      verification.getUTCMinutes() === time.minute &&
      verification.getUTCSeconds() === time.second
    ) {
      return new Date(utc).toISOString();
    }
  }
  return null;
}

function findTimeParts(value) {
  const text = String(value).trim().replace(/^[^\d]+|[^\d]+$/g, "");
  const match = /^([01]?\d|2[0-3])\D+([0-5]?\d)(?:\D+([0-5]?\d))?$/.exec(text);
  return match
    ? { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] ?? 0) }
    : null;
}

function parseSymbol(words) {
  for (const word of words) {
    const token = symbolToken(word.text);
    if (token) return token;
  }
  return null;
}

function symbolToken(value) {
  const compact = String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/.test(compact) ? compact : null;
}

function columnText(words, [left, right]) {
  return words
    .filter((word) => word.xRatio >= left && word.xRatio < right)
    .sort(compareOcrColumns)
    .map((word) => word.text)
    .join(" ")
    .trim();
}

function parseOrderType(value) {
  const compact = String(value).replace(/\s+/g, "").toUpperCase();
  if (/LIMIT/.test(compact) || (compact.includes("限") && compact.includes("价"))) {
    return "LIMIT";
  }
  if (/MARKET/.test(compact) || (compact.includes("市") && compact.includes("价"))) {
    return "MARKET";
  }
  return null;
}

function parsePositionAction(value) {
  const compact = collapseRepeatedCharacters(
    String(value).replace(/\s+/g, "").toLowerCase(),
  );
  if (/开多|做多|openlong/.test(compact)) return "openLong";
  if (/平多|关闭?多仓|closelong/.test(compact)) return "closeLong";
  if (/开空|做空|openshort/.test(compact)) return "openShort";
  if (/平空|关闭?空仓|closeshort/.test(compact)) return "closeShort";
  const chineseOnly = compact.replace(/[^开平多空]/g, "");
  if (chineseOnly.includes("开") && chineseOnly.includes("多")) return "openLong";
  if (chineseOnly.includes("平") && chineseOnly.includes("多")) return "closeLong";
  if (chineseOnly.includes("开") && chineseOnly.includes("空")) return "openShort";
  if (chineseOnly.includes("平") && chineseOnly.includes("空")) return "closeShort";
  return null;
}

function parseNumericColumn(value) {
  const normalized = normalizeOcrNumber(value);
  if (!normalized) return null;
  const match = normalized.match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? { value: number } : null;
}

function parseQuantityColumn(value, asset) {
  let text = String(value)
    .replace(new RegExp(asset, "ig"), "")
    .replace(/\bO(?=\s|$)/gi, "0")
    .trim();
  const hadThousandsSeparator = /\d,\d{3}(?:\D|$)/.test(text);
  const spacedDecimal = text.match(/^\s*(\d+)\s+(\d{1,4})\s*$/);
  if (spacedDecimal) text = `${spacedDecimal[1]}.${spacedDecimal[2]}`;
  const normalized = normalizeOcrNumber(text);
  const match = normalized.match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  if (!Number.isFinite(number) || number < 0) return null;
  const decimalPart = match[0].split(".")[1] ?? "";
  return {
    value: number,
    hadDecimal: decimalPart.length > 0,
    decimalPlaces: decimalPart.length,
    hadThousandsSeparator,
    digitCount: match[0].replace(/\D/g, "").length,
  };
}

function normalizeOcrNumber(value) {
  let normalized = String(value)
    .replace(/[，,]/g, "")
    .replace(/[—–−]/g, "-")
    .replace(/(\d)-(?=\d{2,}(?:\D|$))/g, "$1.")
    .replace(/\s+/g, "");
  const dots = normalized.split(".");
  if (dots.length > 2) {
    normalized = `${dots.slice(0, -1).join("")}.${dots.at(-1)}`;
  }
  return normalized;
}

function parseBooleanColumn(value) {
  const compact = String(value).replace(/\s+/g, "").toUpperCase();
  if (/^(是|YES|TRUE|Y)$/.test(compact)) return true;
  if (/^(否|NO|FALSE|N)$/.test(compact)) return false;
  return null;
}

function parseStatus(value, executedQuantity, originalQuantity) {
  const compact = collapseRepeatedCharacters(
    String(value).replace(/\s+/g, "").toUpperCase(),
  );
  if (/完全.*成.*交|全部.*成.*交|FILLED/.test(compact)) return "FILLED";
  if (/部分成交|PARTIALLYFILLED/.test(compact)) return "PARTIALLY_FILLED";
  if (/已.*取消|已.*撤销|CANCELLED|CANCELED/.test(compact)) return "CANCELED";
  if (/已.*过.*期|过.*期|EXPIRED/.test(compact)) return "EXPIRED";
  if (/新建|挂单中|NEW/.test(compact)) return "NEW";
  if (executedQuantity > 0 && executedQuantity >= originalQuantity - 1e-10) {
    return "FILLED";
  }
  if (executedQuantity > 0) return "PARTIALLY_FILLED";
  return "UNKNOWN";
}

function collapseRepeatedCharacters(value) {
  return String(value).replace(/(.)\1+/gu, "$1");
}

function normalizeOrderType(value) {
  const parsed = parseOrderType(value);
  if (!parsed) throw new TypeError("基础单类型必须是 MARKET 或 LIMIT");
  return parsed;
}

function normalizePositionAction(value) {
  if (["openLong", "closeLong", "openShort", "closeShort"].includes(value)) {
    return value;
  }
  const parsed = parsePositionAction(value);
  if (!parsed) throw new TypeError("基础单方向无效");
  return parsed;
}

function sideForPositionAction(value) {
  return value === "openLong" || value === "closeShort" ? "BUY" : "SELL";
}

function normalizeStatus(value, executedQuantity) {
  const parsed = parseStatus(value, executedQuantity, executedQuantity);
  return parsed === "UNKNOWN" && typeof value === "string" && value.trim()
    ? value.trim().toUpperCase()
    : parsed;
}

function normalizeTriggerCondition(value) {
  const text = String(value ?? "").trim();
  return !text || /^[—–-]+$/.test(text) ? null : text;
}

function optionalBoolean(value) {
  if (typeof value === "boolean") return value;
  return parseBooleanColumn(value);
}

function normalizeIsoTime(value, label) {
  const time = Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) throw new TypeError(`${label}无效`);
  return new Date(time).toISOString();
}

function nullablePositiveNumber(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${label}必须大于 0`);
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label}必须大于或等于 0`);
  }
  return number;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/.test(symbol) ? symbol : "";
}

function averageConfidence(words) {
  const values = words
    .map((word) => word.confidence)
    .filter((value) => value !== null);
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
}

function confidenceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function positiveFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${label}必须大于 0`);
  return number;
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

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function mode(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0] ?? null;
}

function compareOcrColumns(left, right) {
  return left.xRatio - right.xRatio || left.centerY - right.centerY || left.index - right.index;
}

function compareRowAnchors(left, right) {
  return left.centerY - right.centerY || left.centerX - right.centerX;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
