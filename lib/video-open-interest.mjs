const SUPPORTED_PERIODS = new Set([
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
]);

export const VIDEO_OPEN_INTEREST_PAGE_LIMIT = 500;
export const VIDEO_OPEN_INTEREST_MAX_PAGES = 64;

/**
 * 创建桌面视频导出读取历史 OI 时使用的本地 API 地址。
 */
export function createVideoOpenInterestRequestUrl(options) {
  const normalized = normalizeOptions(options);
  return buildRequestUrl(normalized, normalized.startTime);
}

/**
 * 从现有 `/api/market/open-interest` 向后分页读取历史 OI。
 *
 * 每页固定读取 500 条，下一页从上一页最后一个时间戳加 1ms 开始。
 * 返回值只包含接口实际给出的有效数据，不对缺口补零或插值。
 */
export async function fetchVideoOpenInterest(options, fetcher = globalThis.fetch) {
  const normalized = normalizeOptions(options);
  if (typeof fetcher !== "function") {
    throw new TypeError("视频 OI 请求器必须是函数");
  }

  const pointsByTimestamp = new Map();
  let cursor = normalized.startTime;
  let previousPageLastTimestamp = null;
  let pagesFetched = 0;
  let source = null;

  while (pagesFetched < normalized.maxPages) {
    throwIfAborted(normalized.signal);
    const requestUrl = buildRequestUrl(normalized, cursor);
    const response = await fetcher(requestUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: normalized.signal,
    });
    throwIfAborted(normalized.signal);

    if (!response || typeof response !== "object") {
      throw new TypeError("视频 OI 接口没有返回有效响应");
    }

    const payload = await readJsonPayload(response);
    pagesFetched += 1;

    if (response.ok !== true) {
      const message = isRecord(payload) && typeof payload.message === "string"
        ? payload.message.trim()
        : "";
      throw new Error(message || `视频 OI 请求失败（HTTP ${response.status ?? "未知"}）`);
    }

    const page = parsePagePayload(payload, normalized);
    if (source === null && page.source !== null) {
      source = page.source;
    }
    if (page.points.length === 0) {
      return buildResult(normalized, source, pagesFetched, pointsByTimestamp);
    }

    const pageLastTimestamp = page.points.at(-1).timestampMs;
    if (
      previousPageLastTimestamp !== null &&
      pageLastTimestamp <= previousPageLastTimestamp
    ) {
      throw new RangeError("视频 OI 分页游标没有向后推进");
    }

    for (const point of page.points) {
      const existing = pointsByTimestamp.get(point.timestampMs);
      if (existing) {
        if (
          existing.openInterest !== point.openInterest ||
          existing.openInterestValue !== point.openInterestValue
        ) {
          throw new RangeError("视频 OI 同一时间戳的数据不一致");
        }
        continue;
      }
      pointsByTimestamp.set(point.timestampMs, {
        time: point.time,
        openInterest: point.openInterest,
        openInterestValue: point.openInterestValue,
      });
    }

    if (
      page.points.length < VIDEO_OPEN_INTEREST_PAGE_LIMIT ||
      pageLastTimestamp >= normalized.endTime
    ) {
      return buildResult(normalized, source, pagesFetched, pointsByTimestamp);
    }

    previousPageLastTimestamp = pageLastTimestamp;
    cursor = pageLastTimestamp + 1;
  }

  throw new RangeError(
    `视频 OI 分页超过最大分页数 ${normalized.maxPages}，未返回不完整数据`,
  );
}

function normalizeOptions(options) {
  if (!isRecord(options)) {
    throw new TypeError("视频 OI 参数必须是对象");
  }

  const symbol = String(options.symbol ?? "")
    .toUpperCase()
    .replace(/[\s/_-]/g, "");
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    throw new RangeError("视频 OI 交易对格式无效");
  }

  const period = String(options.period ?? "");
  if (!SUPPORTED_PERIODS.has(period)) {
    throw new RangeError("视频 OI 时间框架不受支持");
  }

  const startTime = positiveSafeInteger(options.startTime, "视频 OI 开始时间");
  const endTime = positiveSafeInteger(options.endTime, "视频 OI 结束时间");
  if (startTime > endTime) {
    throw new RangeError("视频 OI 开始时间不能晚于结束时间");
  }

  const maxPages = options.maxPages === undefined
    ? VIDEO_OPEN_INTEREST_MAX_PAGES
    : positiveSafeInteger(options.maxPages, "视频 OI 最大分页数");
  if (maxPages > VIDEO_OPEN_INTEREST_MAX_PAGES) {
    throw new RangeError(
      `视频 OI 最大分页数不能超过 ${VIDEO_OPEN_INTEREST_MAX_PAGES}`,
    );
  }

  const signal = options.signal;
  if (
    signal !== undefined &&
    (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean")
  ) {
    throw new TypeError("视频 OI signal 必须是 AbortSignal");
  }

  return {
    symbol,
    period,
    startTime,
    endTime,
    maxPages,
    signal,
  };
}

function buildRequestUrl(options, startTime) {
  const params = new URLSearchParams({
    symbol: options.symbol,
    period: options.period,
    startTime: String(startTime),
    endTime: String(options.endTime),
    limit: String(VIDEO_OPEN_INTEREST_PAGE_LIMIT),
  });
  return `/api/market/open-interest?${params.toString()}`;
}

async function readJsonPayload(response) {
  if (typeof response.json !== "function") {
    throw new TypeError("视频 OI 响应缺少 JSON 内容");
  }
  try {
    return await response.json();
  } catch {
    throw new TypeError("视频 OI 响应不是有效 JSON");
  }
}

function parsePagePayload(payload, options) {
  if (!isRecord(payload)) {
    throw new TypeError("视频 OI 响应必须是对象");
  }
  if (!Array.isArray(payload.points)) {
    throw new TypeError("视频 OI 响应 points 必须是数组");
  }
  if (payload.points.length > VIDEO_OPEN_INTEREST_PAGE_LIMIT) {
    throw new RangeError(
      `视频 OI 单页不能超过 ${VIDEO_OPEN_INTEREST_PAGE_LIMIT} 条`,
    );
  }
  if (
    payload.symbol !== undefined &&
    String(payload.symbol).toUpperCase() !== options.symbol
  ) {
    throw new RangeError("视频 OI 响应交易对不一致");
  }
  if (
    payload.period !== undefined &&
    String(payload.period) !== options.period
  ) {
    throw new RangeError("视频 OI 响应时间框架不一致");
  }

  const source = typeof payload.source === "string" && payload.source.trim() !== ""
    ? payload.source.trim()
    : null;
  const points = payload.points.map((point, index) =>
    normalizePoint(point, index, options));

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (current.timestampMs < previous.timestampMs) {
      throw new RangeError("视频 OI 时间必须按升序排列");
    }
    if (
      current.timestampMs === previous.timestampMs &&
      (
        current.openInterest !== previous.openInterest ||
        current.openInterestValue !== previous.openInterestValue
      )
    ) {
      throw new RangeError("视频 OI 同一时间戳的数据不一致");
    }
  }

  return { source, points };
}

function normalizePoint(point, index, options) {
  if (!isRecord(point)) {
    throw new TypeError(`视频 OI 第 ${index + 1} 个点必须是对象`);
  }

  const hasTimestamp =
    Object.prototype.hasOwnProperty.call(point, "timestamp") &&
    point.timestamp !== undefined &&
    point.timestamp !== null;
  const hasTime =
    Object.prototype.hasOwnProperty.call(point, "time") &&
    point.time !== undefined &&
    point.time !== null;
  if (!hasTimestamp && !hasTime) {
    throw new TypeError(`视频 OI 第 ${index + 1} 个点缺少 timestamp/time`);
  }

  const timestampMs = hasTimestamp
    ? positiveSafeInteger(point.timestamp, `视频 OI 第 ${index + 1} 个点 timestamp`)
    : positiveSafeInteger(point.time, `视频 OI 第 ${index + 1} 个点 time`) * 1000;
  const time = Math.floor(timestampMs / 1000);

  if (
    hasTime &&
    positiveSafeInteger(point.time, `视频 OI 第 ${index + 1} 个点 time`) !== time
  ) {
    throw new RangeError(`视频 OI 第 ${index + 1} 个点 timestamp/time 不一致`);
  }
  if (timestampMs < options.startTime || timestampMs > options.endTime) {
    throw new RangeError(`视频 OI 第 ${index + 1} 个点超出请求时间范围`);
  }

  const openInterest = nonNegativeFiniteNumber(
    point.openInterest,
    `视频 OI 第 ${index + 1} 个点 openInterest`,
  );
  const openInterestValue = nonNegativeFiniteNumber(
    point.openInterestValue,
    `视频 OI 第 ${index + 1} 个点 openInterestValue`,
  );

  return {
    timestampMs,
    time,
    openInterest,
    openInterestValue,
  };
}

function buildResult(options, source, pagesFetched, pointsByTimestamp) {
  const entries = [...pointsByTimestamp.entries()]
    .sort((left, right) => left[0] - right[0]);
  return {
    source,
    symbol: options.symbol,
    period: options.period,
    pagesFetched,
    points: entries.map(([, point]) => point),
  };
}

function positiveSafeInteger(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new RangeError(`${label}必须是大于 0 的安全整数`);
  }
  return value;
}

function nonNegativeFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}必须是大于或等于 0 的有限数字`);
  }
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
  }
  throw new DOMException("操作已取消", "AbortError");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
