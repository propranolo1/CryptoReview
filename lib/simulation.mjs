/**
 * 用一段真实历史 K 线生成“首根开盘入场、末根收盘交割”的模拟交易。
 * 该函数只负责组装复盘记录，不根据 K 线猜测止盈止损成交。
 */
export function createSettlementTrade({
  symbol,
  side,
  quantity,
  candles,
  stopLoss = null,
  takeProfit = null,
  entryFee = 0,
  exitFee = 0,
}) {
  if (!Array.isArray(candles) || candles.length < 2) {
    throw new TypeError("模拟交割至少需要两根 K 线");
  }
  if (side !== "long" && side !== "short") {
    throw new TypeError("模拟交割方向必须是 long 或 short");
  }

  const normalizedQuantity = positiveNumber(quantity, "交割数量");
  const sortedCandles = [...candles].sort((left, right) => left.time - right.time);
  const firstCandle = sortedCandles[0];
  const lastCandle = sortedCandles.at(-1);
  const entryPrice = positiveNumber(firstCandle.open, "入场价格");
  const exitPrice = positiveNumber(lastCandle.close, "交割价格");
  const entryTimeMs = Number(firstCandle.time) * 1000;
  const exitTimeMs = Number.isFinite(Number(lastCandle.closeTime))
    ? Number(lastCandle.closeTime)
    : Number(lastCandle.time) * 1000;

  if (!Number.isFinite(entryTimeMs) || !Number.isFinite(exitTimeMs)) {
    throw new TypeError("模拟交割时间无效");
  }

  const entryTime = new Date(entryTimeMs).toISOString();
  const exitTime = new Date(exitTimeMs).toISOString();
  const normalizedEntryFee = nonNegativeNumber(entryFee, "入场手续费");
  const normalizedExitFee = nonNegativeNumber(exitFee, "交割手续费");

  return {
    symbol: String(symbol).toUpperCase(),
    side,
    quantity: normalizedQuantity,
    entryPrice,
    entryTime,
    stopLoss: optionalPositiveNumber(stopLoss, "止损价格"),
    takeProfit: optionalPositiveNumber(takeProfit, "止盈价格"),
    exitPrice,
    exitTime,
    fee: normalizedEntryFee,
    exits: [
      {
        quantity: normalizedQuantity,
        exitPrice,
        exitTime,
        fee: normalizedExitFee,
      },
    ],
  };
}

/** 用新版内置交易替换旧示例，同时保留浏览器中用户导入的记录。 */
export function mergeDefaultAndImportedTrades(defaultTrades, savedTrades) {
  const importedTrades = Array.isArray(savedTrades)
    ? savedTrades.filter(
        (trade) => trade && typeof trade.id === "string" && trade.id.startsWith("import-"),
      )
    : [];
  return [...defaultTrades, ...importedTrades];
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${label}价格无效`);
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label}无效`);
  }
  return number;
}

function optionalPositiveNumber(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return positiveNumber(value, label);
}
