const FIELD_ALIASES = {
  symbol: ["symbol", "交易对", "pair", "ticker"],
  side: ["side", "方向"],
  quantity: ["quantity", "数量", "qty", "size", "仓位数量"],
  entryPrice: ["entryPrice", "entry_price", "开仓价", "入场价"],
  entryTime: ["entryTime", "entry_time", "开仓时间", "入场时间"],
  stopLoss: ["stopLoss", "stop_loss", "止损"],
  takeProfit: ["takeProfit", "take_profit", "止盈"],
  exitPrice: ["exitPrice", "exit_price", "平仓价", "退出价"],
  exitTime: ["exitTime", "exit_time", "平仓时间", "退出时间"],
  exitQuantity: ["exitQuantity", "exit_quantity", "平仓数量", "退出数量"],
  fee: ["fee", "手续费"],
  exits: ["exits", "退出成交", "平仓记录"],
};

const LONG_SIDES = new Set(["long", "buy", "多", "做多", "买入"]);
const SHORT_SIDES = new Set(["short", "sell", "空", "做空", "卖出"]);
const QUANTITY_EPSILON = 1e-12;

/**
 * 计算单段仓位盈亏。多仓随价格上涨盈利，空仓方向相反。
 */
export function calculatePositionPnl({
  side,
  entryPrice,
  price,
  quantity,
  fee = 0,
}) {
  const normalizedSide = normalizeSide(side, "仓位");
  const normalizedEntryPrice = positiveNumber(entryPrice, "开仓价");
  const normalizedPrice = positiveNumber(price, "成交价或当前价");
  const normalizedQuantity = positiveNumber(quantity, "数量");
  const normalizedFee = nonNegativeNumber(fee, "手续费");
  const direction = normalizedSide === "long" ? 1 : -1;

  return cleanNumber(
    (normalizedPrice - normalizedEntryPrice) *
      normalizedQuantity *
      direction -
      normalizedFee,
  );
}

/**
 * 汇总一笔交易在当前回放时刻的已实现、未实现与总盈亏。
 * 顶层 fee 视为交易级手续费，按已退出和剩余数量等比例分摊；
 * 每笔退出成交自身的 fee 全部计入已实现盈亏。
 */
export function calculateTradePnl(trade, currentPrice) {
  if (!isPlainObject(trade)) {
    throw new TypeError("交易必须是对象");
  }

  const side = normalizeSide(trade.side, "交易");
  const quantity = positiveNumber(trade.quantity, "交易数量");
  const entryPrice = positiveNumber(trade.entryPrice, "开仓价");
  const tradeFee = nonNegativeNumber(trade.fee ?? 0, "交易手续费");
  const exits = exitsForCalculation(trade, quantity);

  let exitedQuantity = 0;
  let grossRealizedPnl = 0;
  let exitFees = 0;

  for (const [index, exit] of exits.entries()) {
    const exitQuantity = positiveNumber(
      exit.quantity,
      `第 ${index + 1} 笔退出数量`,
    );
    const exitPrice = positiveNumber(
      exit.exitPrice ?? exit.price,
      `第 ${index + 1} 笔退出价格`,
    );
    const exitFee = nonNegativeNumber(
      exit.fee ?? 0,
      `第 ${index + 1} 笔退出手续费`,
    );

    exitedQuantity += exitQuantity;
    grossRealizedPnl += calculatePositionPnl({
      side,
      entryPrice,
      price: exitPrice,
      quantity: exitQuantity,
    });
    exitFees += exitFee;
  }

  if (exitedQuantity - quantity > QUANTITY_EPSILON) {
    throw new RangeError("退出总数量不能超过交易数量");
  }

  if (Math.abs(exitedQuantity - quantity) <= QUANTITY_EPSILON) {
    exitedQuantity = quantity;
  }
  const remainingQuantity = quantity - exitedQuantity;
  const exitedTradeFee = tradeFee * (exitedQuantity / quantity);
  const remainingTradeFee = tradeFee - exitedTradeFee;
  const realizedPnl = grossRealizedPnl - exitFees - exitedTradeFee;

  let unrealizedPnl = 0;
  if (remainingQuantity > QUANTITY_EPSILON) {
    if (currentPrice === undefined || currentPrice === null || currentPrice === "") {
      throw new TypeError("交易仍有未平仓数量，必须提供当前回放价");
    }
    unrealizedPnl =
      calculatePositionPnl({
        side,
        entryPrice,
        price: currentPrice,
        quantity: remainingQuantity,
      }) - remainingTradeFee;
  }

  const entryNotional = entryPrice * quantity;
  const totalPnl = realizedPnl + unrealizedPnl;
  const returnRate = totalPnl / entryNotional;

  return {
    entryNotional: cleanNumber(entryNotional),
    exitedQuantity: cleanNumber(exitedQuantity),
    remainingQuantity: cleanNumber(remainingQuantity),
    realizedPnl: cleanNumber(realizedPnl),
    unrealizedPnl: cleanNumber(unrealizedPnl),
    totalPnl: cleanNumber(totalPnl),
    returnRate: cleanNumber(returnRate),
    returnRatePercent: cleanNumber(returnRate * 100),
  };
}

/**
 * 将 CSV、JSON 字符串或已解析的 JSON 数据统一转换为交易数组。
 */
export function parseTrades(input, format = "auto") {
  const normalizedFormat = String(format).trim().toLowerCase();
  if (!["auto", "csv", "json"].includes(normalizedFormat)) {
    throw new TypeError(`不支持的导入格式：${format}`);
  }

  let records;
  if (typeof input === "string") {
    const source = input.replace(/^\uFEFF/, "").trim();
    if (!source) {
      return [];
    }

    const detectedFormat =
      normalizedFormat === "auto"
        ? source.startsWith("[") || source.startsWith("{")
          ? "json"
          : "csv"
        : normalizedFormat;

    if (detectedFormat === "json") {
      try {
        records = extractJsonRecords(JSON.parse(source));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new SyntaxError(`JSON 解析失败：${error.message}`);
        }
        throw error;
      }
    } else {
      records = csvToRecords(source);
    }
  } else {
    if (normalizedFormat === "csv") {
      throw new TypeError("CSV 导入内容必须是字符串");
    }
    records = extractJsonRecords(input);
  }

  return records.map((record, index) => normalizeTrade(record, index));
}

function normalizeTrade(record, index) {
  const label = `第 ${index + 1} 笔交易`;
  if (!isPlainObject(record)) {
    throw new TypeError(`${label}必须是对象`);
  }

  const symbolValue = pick(record, FIELD_ALIASES.symbol);
  const symbol = stringOrNull(symbolValue);
  if (!symbol) {
    throw new TypeError(`${label}缺少交易对`);
  }

  const side = normalizeSide(pick(record, FIELD_ALIASES.side), label);
  const quantity = positiveNumber(
    pick(record, FIELD_ALIASES.quantity),
    `${label}的数量`,
  );
  const entryPrice = positiveNumber(
    pick(record, FIELD_ALIASES.entryPrice),
    `${label}的开仓价`,
  );
  const entryTime = stringOrNull(pick(record, FIELD_ALIASES.entryTime));
  const stopLoss = optionalPositiveNumber(
    pick(record, FIELD_ALIASES.stopLoss),
    `${label}的止损`,
  );
  const takeProfit = optionalPositiveNumber(
    pick(record, FIELD_ALIASES.takeProfit),
    `${label}的止盈`,
  );
  const exitPrice = optionalPositiveNumber(
    pick(record, FIELD_ALIASES.exitPrice),
    `${label}的平仓价`,
  );
  const exitTime = stringOrNull(pick(record, FIELD_ALIASES.exitTime));
  const fee = nonNegativeNumber(
    emptyToDefault(pick(record, FIELD_ALIASES.fee), 0),
    `${label}的手续费`,
  );

  const rawExits = pick(record, FIELD_ALIASES.exits);
  let exits = [];
  if (!isEmpty(rawExits)) {
    if (!Array.isArray(rawExits)) {
      throw new TypeError(`${label}的退出成交必须是数组`);
    }
    exits = rawExits.map((exit, exitIndex) =>
      normalizeExit(exit, label, exitIndex),
    );
  } else if (exitPrice !== null) {
    exits = [
      {
        quantity: optionalPositiveNumber(
          pick(record, FIELD_ALIASES.exitQuantity),
          `${label}的平仓数量`,
        ) ?? quantity,
        exitPrice,
        exitTime,
        fee: 0,
      },
    ];
  }

  const totalExitQuantity = exits.reduce(
    (total, exit) => total + exit.quantity,
    0,
  );
  if (totalExitQuantity - quantity > QUANTITY_EPSILON) {
    throw new RangeError(`${label}的退出总数量不能超过交易数量`);
  }

  return {
    symbol,
    side,
    quantity,
    entryPrice,
    entryTime,
    stopLoss,
    takeProfit,
    exitPrice,
    exitTime,
    fee,
    exits,
  };
}

function normalizeExit(exit, tradeLabel, index) {
  const label = `${tradeLabel}的第 ${index + 1} 笔退出成交`;
  if (!isPlainObject(exit)) {
    throw new TypeError(`${label}必须是对象`);
  }

  return {
    quantity: positiveNumber(
      pick(exit, FIELD_ALIASES.quantity),
      `${label}数量`,
    ),
    exitPrice: positiveNumber(
      pick(exit, FIELD_ALIASES.exitPrice),
      `${label}价格`,
    ),
    exitTime: stringOrNull(pick(exit, FIELD_ALIASES.exitTime)),
    fee: nonNegativeNumber(
      emptyToDefault(pick(exit, FIELD_ALIASES.fee), 0),
      `${label}手续费`,
    ),
  };
}

function exitsForCalculation(trade, quantity) {
  if (Array.isArray(trade.exits) && trade.exits.length > 0) {
    return trade.exits;
  }
  if (!isEmpty(trade.exitPrice)) {
    return [
      {
        quantity: isEmpty(trade.exitQuantity) ? quantity : trade.exitQuantity,
        exitPrice: trade.exitPrice,
        exitTime: trade.exitTime ?? null,
        fee: trade.exitFee ?? 0,
      },
    ];
  }
  return [];
}

function extractJsonRecords(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (isPlainObject(value)) {
    if (Array.isArray(value.trades)) {
      return value.trades;
    }
    if (Array.isArray(value.交易)) {
      return value.交易;
    }
    return [value];
  }
  throw new TypeError("JSON 导入内容必须是交易对象或交易数组");
}

function csvToRecords(source) {
  const rows = parseCsvRows(source).filter((row) =>
    row.some((cell) => cell.trim() !== ""),
  );
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((header, index) => {
    const normalized = header.replace(/^\uFEFF/, "").trim();
    if (!normalized) {
      throw new TypeError(`CSV 第 ${index + 1} 列缺少字段名`);
    }
    return normalized;
  });

  return rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])),
  );
}

// 轻量 CSV 状态机，支持引号内逗号、换行与双引号转义。
function parseCsvRows(source) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new SyntaxError("CSV 存在未闭合的引号");
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function normalizeSide(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (LONG_SIDES.has(normalized)) {
    return "long";
  }
  if (SHORT_SIDES.has(normalized)) {
    return "short";
  }
  throw new TypeError(`${label}的方向无效：${String(value ?? "")}`);
}

function pick(record, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) {
      return record[alias];
    }
  }
  return undefined;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return number;
}

function optionalPositiveNumber(value, label) {
  return isEmpty(value) ? null : positiveNumber(value, label);
}

function nonNegativeNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) {
    throw new RangeError(`${label}不能小于 0`);
  }
  return number;
}

function finiteNumber(value, label) {
  if (isEmpty(value)) {
    throw new TypeError(`${label}不能为空`);
  }
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label}必须是有效数字`);
  }
  return number;
}

function stringOrNull(value) {
  if (isEmpty(value)) {
    return null;
  }
  return String(value).trim();
}

function emptyToDefault(value, defaultValue) {
  return isEmpty(value) ? defaultValue : value;
}

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 清理由二进制浮点计算产生的微小尾差，保留足够的交易精度。
function cleanNumber(value) {
  return Number(value.toFixed(12));
}
