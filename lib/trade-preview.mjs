import { buildReplayTradeSnapshot } from "./replay.mjs";
import { getTradeCloseTime } from "./performance.mjs";
import { isBinanceSymbol, normalizeBinanceSymbol } from "./exchange-sync.mjs";

const MINUTE = 60_000;
const INTERVALS = [["1m", 1], ["3m", 3], ["5m", 5], ["15m", 15], ["30m", 30],
  ["1h", 60], ["2h", 120], ["4h", 240], ["6h", 360], ["8h", 480],
  ["12h", 720], ["1d", 1440], ["3d", 4320], ["1w", 10080]];

/** 预览独立使用整笔交易的成交；不改变主图回放状态。 */
export function buildTradePreviewPlan(trade, now = Date.now()) {
  const symbol = normalizeBinanceSymbol(trade.symbol);
  if (!isBinanceSymbol(symbol)) throw new Error("交易对格式无效");
  const open = Boolean(trade.openPosition);
  const events = buildReplayTradeSnapshot(trade, open ? now : Infinity).events
    .filter((event) => Number.isFinite(event.timeMs) && event.timeMs > 0);
  const entryTimes = events.filter((event) => event.type === "entry").map((event) => event.timeMs);
  if (!entryTimes.length) throw new Error("缺少有效入场时间，无法预览行情");
  const entryTime = Math.min(...entryTimes);
  const tradeEndTime = open ? now : getTradeCloseTime(trade);
  if (!Number.isFinite(tradeEndTime) || tradeEndTime < entryTime || entryTime > now) {
    throw new Error("交易起止时间无效，无法预览行情");
  }
  const holdingMs = tradeEndTime - entryTime;
  // 极短交易至少保留一分钟上下文，避免同柱开平仓时横轴退化。
  const paddingMs = Math.max(MINUTE, Math.ceil(holdingMs * 0.1));
  const endTime = Math.min(now, tradeEndTime + (open ? 0 : paddingMs));
  const rawStart = Math.max(1, entryTime - paddingMs);
  const [interval, minutes] = INTERVALS.find(([, size]) => (endTime - rawStart) / (size * MINUTE) <= 180) ?? INTERVALS.at(-1);
  const intervalMs = minutes * MINUTE;
  const startTime = Math.max(1, Math.floor(rawStart / intervalMs) * intervalMs);
  // 额外读取一根前置 K 线，兼容周线等不按 Unix 零点对齐的自然周期。
  const requestStartTime = Math.max(1, startTime - intervalMs);
  const limit = Math.ceil((endTime - requestStartTime) / intervalMs) + 2;
  if (limit > 4000) throw new Error("交易跨度过长，无法读取完整缩略行情");
  return { symbol, market: trade.marketDataSource ?? "binance", interval, intervalMs,
    startTime, requestStartTime, endTime, entryTime, tradeEndTime, holdingMs, paddingMs, limit, open,
    events: events.filter((event) => event.timeMs >= entryTime && event.timeMs <= tradeEndTime) };
}

/** 固定像素尺寸；位置限制在当前窗口内。 */
export function getTradePreviewPosition(bounds, viewport) {
  let left = bounds.right + 8;
  if (left + 380 > viewport.width - 8) left = bounds.left - 380 - 8;
  return { left: Math.max(8, Math.min(left, viewport.width - 380 - 8)),
    top: Math.max(8, Math.min(bounds.top, viewport.height - 220 - 8)) };
}

/** 收盘价折线与实际成交价使用同一比例；缺失行情处断线而非补价格。 */
export function buildTradePreviewPlot(candles, plan) {
  const clean = candles.filter((candle) => Number.isFinite(candle.time) && candle.time > 0 &&
    Number.isFinite(candle.close) && candle.close > 0 && Number.isFinite(candle.closeTime) &&
    candle.closeTime >= candle.time * 1000 && candle.closeTime >= plan.startTime && candle.time * 1000 <= plan.endTime)
    .sort((a, b) => a.time - b.time)
    .filter((candle, index, list) => index === 0 || candle.time !== list[index - 1].time);
  if (!clean.length) throw new Error("没有取得可用的真实行情");
  if (clean[0].time * 1000 > plan.entryTime || clean.at(-1).closeTime < plan.tradeEndTime) {
    throw new Error("行情未覆盖完整持仓过程，请稍后重试");
  }
  const prices = [...clean.map((candle) => candle.close), ...plan.events.map((event) => event.price)];
  const low = Math.min(...prices), high = Math.max(...prices);
  const margin = Math.max((high - low) * 0.12, high * 0.001, 0.00000001);
  const minimum = low - margin, maximum = high + margin;
  const x = (time) => 8 + Math.max(0, Math.min(1, (time - plan.startTime) / Math.max(1, plan.endTime - plan.startTime))) * 294;
  const y = (price) => 124 - (price - minimum) / (maximum - minimum) * 108;
  let gaps = false;
  const path = clean.map((candle, index) => {
    const gap = index > 0 && (candle.time - clean[index - 1].time) * 1000 > plan.intervalMs * 1.5;
    gaps ||= gap;
    return `${index === 0 || gap ? "M" : "L"}${x(Math.min(candle.closeTime, plan.endTime)).toFixed(2)},${y(candle.close).toFixed(2)}`;
  }).join(" ");
  const groups = [];
  for (const event of plan.events) {
    const group = groups.find((item) => item.side === event.side && Math.abs(x(item.timeMs) - x(event.timeMs)) < 9 && Math.abs(y(item.price) - y(event.price)) < 9);
    if (group) {
      const total = group.quantity + event.quantity;
      group.price = (group.price * group.quantity + event.price * event.quantity) / total;
      group.timeMs = (group.timeMs * group.quantity + event.timeMs * event.quantity) / total;
      group.quantity = total;
      group.events.push(event);
    } else groups.push({ side: event.side, price: event.price, timeMs: event.timeMs, quantity: event.quantity, events: [event] });
  }
  const markers = [];
  for (const group of groups) {
    const px = x(group.timeMs), py = y(group.price);
    let labelY = Math.max(10, Math.min(130, py + (group.side === "buy" ? 15 : -10)));
    for (let lane = 0; lane < 8 && markers.some((item) => Math.abs(item.x - px) < 23 && Math.abs(item.labelY - labelY) < 12); lane++) {
      labelY = Math.max(10, Math.min(130, py + (lane % 2 ? -1 : 1) * (24 + Math.floor(lane / 2) * 13)));
    }
    markers.push({ ...group, x: px, y: py, labelY });
  }
  const partialContext = clean[0].time * 1000 > plan.startTime || clean.at(-1).closeTime < plan.endTime;
  return { path, markers, minimum, maximum, entryX: x(plan.entryTime), endX: x(plan.tradeEndTime),
    notice: gaps ? "部分行情缺失，折线已断开" : partialContext ? "交易前后行情未完全覆盖" : "" };
}

/** 悬停延迟、取消、过期缓存和请求身份在同一处管理，迟到响应无法覆盖新交易。 */
export function createTradePreviewController({ fetchImpl, onChange, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const cache = new Map();
  let opening = null, closing = null, pending = null, active = null, disposed = false;
  const clearOpening = () => { if (opening !== null) clearTimer(opening); opening = null; };
  const retain = () => { if (closing !== null) clearTimer(closing); closing = null; };
  const close = () => {
    clearOpening(); retain(); pending = null;
    active?.controller.abort(); active = null;
    if (!disposed) onChange(null);
  };
  const enter = (trade, bounds, viewport) => {
    if (disposed) return;
    retain();
    const identity = JSON.stringify([trade.id, trade.symbol, trade.side, trade.marketDataSource,
      trade.entryTime, trade.entryPrice, trade.quantity, trade.entries, trade.exits, trade.exitTime, trade.exitPrice, trade.openPosition]);
    if (pending?.identity === identity || active?.identity === identity) return;
    close();
    pending = { identity };
    opening = setTimer(() => {
      opening = null; pending = null;
      const controller = new AbortController();
      const request = { identity, controller };
      active = request;
      const position = getTradePreviewPosition(bounds, viewport);
      let plan;
      try { plan = buildTradePreviewPlan(trade, now()); }
      catch (error) { onChange({ trade, position, status: "error", message: error.message }); return; }
      const state = { trade, position, plan, status: "loading", message: "正在加载完整交易行情…" };
      const saved = cache.get(identity);
      if (saved && now() < saved.expiresAt) {
        cache.delete(identity); cache.set(identity, saved);
        onChange({ ...state, plan: saved.plan, status: "ready", plot: saved.plot, source: saved.source });
        return;
      }
      onChange(state);
      void (async () => {
        try {
          const query = new URLSearchParams({ symbol: plan.symbol, market: plan.market, interval: plan.interval,
            startTime: String(plan.requestStartTime), endTime: String(plan.endTime), limit: String(plan.limit) });
          const response = await fetchImpl(`/api/market/klines?${query}`, { signal: controller.signal });
          const payload = await response.json();
          if (controller.signal.aborted || active !== request || disposed) return;
          if (!response.ok) throw new Error(payload?.message || "行情读取失败，请稍后重试");
          if (normalizeBinanceSymbol(payload?.symbol) !== plan.symbol) throw new Error("行情响应交易对不一致");
          if (payload.interval !== plan.interval || !Array.isArray(payload.candles)) throw new Error("行情响应格式无效");
          const plot = buildTradePreviewPlot(payload.candles, plan);
          const source = plan.market === "binance-futures" ? "Binance U 本位行情" : "Binance 现货行情";
          cache.set(identity, { plan, plot, source,
            expiresAt: plan.open || plan.endTime < plan.tradeEndTime + plan.paddingMs ? now() + 60_000 : Infinity });
          while (cache.size > 32) cache.delete(cache.keys().next().value);
          onChange({ ...state, status: "ready", plot, source });
        } catch (error) {
          if (!controller.signal.aborted && active === request && !disposed) {
            onChange({ ...state, status: "error", message: error.message || "行情读取失败，请稍后重试" });
          }
        }
      })();
    }, 300);
  };
  return { enter, retain, close,
    leave() {
      clearOpening(); pending = null; retain();
      closing = setTimer(close, 150);
    },
    dispose() { disposed = true; close(); cache.clear(); },
  };
}
