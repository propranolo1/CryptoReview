import { getTradeToken } from "./trade-index.mjs";
import { normalizeIconToken, isValidIconRecord } from "./asset-icons.mjs";

/** 可见行按币种合并请求，限制并发；图片解码失败也保留短期失败缓存。 */
export function createAssetIconLoader(options = {}) {
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const now = options.now ?? Date.now;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0;
  const tokenFor = (symbol) => normalizeIconToken(getTradeToken(symbol));
  function remember(token, src, until) {
    cache.delete(token); cache.set(token, { src, until });
    while (cache.size > 256) cache.delete(cache.keys().next().value);
  }
  function pump() {
    while (active < maxConcurrent && queue.length) {
      active++;
      const job = queue.shift();
      job().finally(() => { active--; pump(); });
    }
  }
  return {
    reportFailure(symbol, src) {
      const token = tokenFor(symbol);
      if (cache.get(token)?.src === src) remember(token, null, now() + 60_000);
    },
    async load(symbol) {
      const token = tokenFor(symbol);
      if (!token) return null;
      const existing = cache.get(token);
      if (existing && now() < existing.until) return existing.src;
      if (!pending.has(token)) {
        const task = new Promise((resolve) => queue.push(async () => {
          let src = null;
          try {
            const response = await fetchImpl(`/api/assets/icon?${new URLSearchParams({ token })}`, {
              signal: AbortSignal.timeout(30_000), credentials: "same-origin",
            });
            if (response.ok) {
              const payload = await response.json();
              if (isValidIconRecord({ ...payload, updatedAt: now() }, token)) src = payload.src;
            }
          } catch { /* 图标加载失败不阻断交易列表。 */ }
          remember(token, src, now() + (src ? 86400_000 : 60_000));
          resolve(src);
        }));
        pending.set(token, task.finally(() => pending.delete(token)));
        pump();
      }
      return pending.get(token);
    },
  };
}
