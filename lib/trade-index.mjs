/** 根据交易对提取代币；不同计价币的同一种代币共用索引。 */
export function getTradeToken(symbol) {
  const normalized = String(symbol ?? "").trim().toUpperCase().replace(/[\s/_-]/g, "");
  for (const quote of ["USDT", "USDC", "BUSD", "USD", "BTC", "ETH"]) {
    if (normalized.length > quote.length && normalized.endsWith(quote)) {
      return normalized.slice(0, -quote.length);
    }
  }
  return normalized;
}

export function groupTradesByToken(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const token = getTradeToken(trade.symbol);
    if (!token) continue;
    groups.set(token, (groups.get(token) ?? 0) + 1);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(([token, count]) => ({ token, count }));
}

export function filterTradesByToken(trades, token) {
  return token === null ? [...trades] : trades.filter((trade) => getTradeToken(trade.symbol) === token);
}
