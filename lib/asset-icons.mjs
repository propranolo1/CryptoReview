const CATALOG_URL = "https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset";
const CDN_HOSTS = new Set(["bin.bnbstatic.com", "ex.bnbstatic.com"]);
const IMAGE_LIMIT = 256 * 1024;
const CATALOG_TTL = 6 * 3600_000;
const ICON_TTL = 30 * 86400_000;
const RETRY_DELAY = 60_000;
// 只处理明确的合约倍数名称；1INCH、1000SATS 等原生币名保持原样。
const ALIASES = new Map(Object.entries({
  "1000PEPE": "PEPE", "1000SHIB": "SHIB", "1000BONK": "BONK", "1000FLOKI": "FLOKI",
  "1000LUNC": "LUNC", "1000XEC": "XEC", "1000RATS": "RATS", "1000000MOG": "MOG",
  "1000WHY": "WHY", "1000000BOB": "BOB", "1000TURBO": "TURBO",
}));

export function normalizeIconToken(value) {
  const token = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[\p{L}\p{N}]{1,40}$/u.test(token) ? ALIASES.get(token) ?? token : "";
}

function safeLogoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && CDN_HOSTS.has(url.hostname) && !url.port &&
      !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function imageType(bytes) {
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value) &&
    String.fromCharCode(...bytes.slice(12, 16)) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6)))) return "image/gif";
  return null;
}

export function isValidIconRecord(record, token) {
  if (!record || record.token !== token || !Number.isSafeInteger(record.updatedAt) || record.updatedAt <= 0 ||
    typeof record.src !== "string" || record.src.length > IMAGE_LIMIT * 1.4) return false;
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(record.src);
  if (!match) return false;
  try {
    const bytes = Uint8Array.from(atob(match[2]), (value) => value.charCodeAt(0));
    return bytes.length <= IMAGE_LIMIT && imageType(bytes) === match[1];
  } catch { return false; }
}

async function readLimited(response, limit) {
  if (!response.ok || Number(response.headers.get("Content-Length")) > limit || !response.body) {
    await response.body?.cancel();
    throw new Error("图标响应不可用或超出大小限制");
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("图标响应超出大小限制"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function dataUrl(type, bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}

/** 图标元数据、图片请求与交易读取相互独立，缓存可以由桌面端注入。 */
export function createAssetIconService(options = {}) {
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 256;
  const cache = new Map(), pending = new Map();
  let catalog = null, catalogUntil = 0, catalogTask = null, catalogRetryAt = 0;

  function remember(token, record, retryAt) {
    cache.delete(token);
    cache.set(token, { record, retryAt });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  async function loadCatalog() {
    if (catalog && now() < catalogUntil) return catalog;
    if (now() < catalogRetryAt) throw new Error("图标目录等待重试");
    if (!catalogTask) {
      catalogTask = (async () => {
        const response = await fetchImpl(CATALOG_URL, { credentials: "omit", redirect: "error",
          cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { Accept: "application/json" } });
        const payload = JSON.parse(new TextDecoder().decode(await readLimited(response, 4 * 1024 * 1024)));
        if (payload.success === false || String(payload.code) !== "000000" || !Array.isArray(payload.data)) {
          throw new Error("币安图标目录无效");
        }
        const next = new Map();
        for (const item of payload.data) {
          const token = normalizeIconToken(item?.assetCode), url = safeLogoUrl(item?.logoUrl);
          if (!token || !url) continue;
          // 同名币对应不同图片时宁可保留字母，避免误认。
          next.set(token, next.has(token) && next.get(token) !== url ? null : url);
        }
        if (!next.size) throw new Error("币安图标目录为空");
        catalog = next; catalogUntil = now() + CATALOG_TTL;
        return catalog;
      })().catch((error) => { catalogRetryAt = now() + RETRY_DELAY; throw error; })
        .finally(() => { catalogTask = null; });
    }
    return catalogTask;
  }

  async function refresh(token, previous = null) {
    try {
      const url = (await loadCatalog()).get(token);
      if (!url) { remember(token, previous, now() + CATALOG_TTL); return previous; }
      const response = await fetchImpl(url, { credentials: "omit", redirect: "error",
        cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { Accept: "image/png,image/webp,image/jpeg,image/gif" } });
      const bytes = await readLimited(response, IMAGE_LIMIT);
      const type = imageType(bytes), declared = response.headers.get("Content-Type")?.split(";", 1)[0].trim();
      if (!type || type !== declared) throw new Error("图片内容或类型无效");
      const record = { token, src: dataUrl(type, bytes), updatedAt: now() };
      remember(token, record, now() + ICON_TTL);
      try { await options.writeCache?.(record); } catch { /* 缓存不可写不影响图标显示。 */ }
      return record;
    } catch { remember(token, previous, now() + RETRY_DELAY); return previous; }
  }

  function start(token, job) {
    if (!pending.has(token)) pending.set(token, job().finally(() => pending.delete(token)));
    return pending.get(token);
  }

  return {
    get cacheSize() { return cache.size; },
    async settled() { await Promise.allSettled([...pending.values()]); },
    async getIcon(value) {
      const token = normalizeIconToken(value);
      if (!token) return null;
      const existing = cache.get(token);
      if (existing) {
        remember(token, existing.record, existing.retryAt);
        if (now() >= existing.retryAt) {
          const task = start(token, () => refresh(token, existing.record));
          if (!existing.record) return task;
        }
        return existing.record;
      }
      const record = await start(token, async () => {
        let stored;
        try { stored = await options.readCache?.(token); } catch { /* 损坏或不可读缓存回退到网络。 */ }
        if (isValidIconRecord(stored, token) && stored.updatedAt <= now()) {
          remember(token, stored, stored.updatedAt + ICON_TTL);
          return stored;
        }
        return refresh(token);
      });
      if (record && now() >= record.updatedAt + ICON_TTL) start(token, () => refresh(token, record));
      return record;
    },
  };
}

export async function assetIconResponse(request, service) {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const token = normalizeIconToken(new URL(request.url).searchParams.get("token"));
  if (!token) return Response.json({ message: "币种无效。" }, { status: 400 });
  const icon = await service.getIcon(token);
  return icon ? Response.json({ token, src: icon.src }, {
    headers: { "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  }) : Response.json({ token, src: null }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
