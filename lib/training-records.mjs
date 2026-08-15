import { calculateTrainingPerformance } from "./training.mjs";

const EXPORT_TYPE = "cryptoreview-training-results";
const EXPORT_VERSION = 1;
const TRAINING_INTERVALS = new Set(["5m", "15m", "1h", "4h"]);

/**
 * 把已完成训练记录导出为可长期识别的版本化 JSON。
 */
export function serializeTrainingResultsExport(results, options = {}) {
  const records = normalizeRecordCollection(results);
  const exportedAt = normalizeTime(
    options.exportedAt ?? new Date().toISOString(),
    "导出时间",
  );
  return JSON.stringify({
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    exportedAt,
    records,
  }, null, 2);
}

/**
 * 读取 CryptoReview 训练记录 JSON。
 * 同时兼容早期直接导出数组的格式。
 */
export function parseTrainingResultsImport(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError("训练记录文件不能为空");
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    throw new SyntaxError("训练记录文件不是有效 JSON");
  }

  if (Array.isArray(payload)) {
    return normalizeRecordCollection(payload);
  }
  if (!isRecord(payload) || payload.type !== EXPORT_TYPE) {
    throw new TypeError("不是 CryptoReview 训练记录文件");
  }
  if (payload.version !== EXPORT_VERSION) {
    throw new RangeError(`不支持的训练记录版本：${String(payload.version)}`);
  }
  return normalizeRecordCollection(payload.records);
}

/**
 * 按训练 id 合并多组记录；同一 id 保留 recordedAt（缺失时使用 endedAt）较新的版本。
 * 无效的旧本地记录会被忽略，严格的文件校验由 parseTrainingResultsImport 负责。
 */
export function mergeTrainingResultRecords(...collections) {
  const recordsById = new Map();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      let record;
      try {
        record = normalizeTrainingRecord(value, 0);
      } catch {
        continue;
      }
      const existing = recordsById.get(record.id);
      const recordTime = Date.parse(record.recordedAt ?? record.endedAt);
      const existingTime = existing
        ? Date.parse(existing.recordedAt ?? existing.endedAt)
        : Number.NEGATIVE_INFINITY;
      if (!existing || recordTime >= existingTime) {
        recordsById.set(record.id, record);
      }
    }
  }

  return [...recordsById.values()].sort(
    (left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt),
  );
}

function normalizeRecordCollection(records) {
  if (!Array.isArray(records)) {
    throw new TypeError("训练记录必须是数组");
  }
  const ids = new Set();
  return records.map((record, index) => {
    const normalized = normalizeTrainingRecord(record, index);
    if (ids.has(normalized.id)) {
      throw new TypeError(`训练记录存在重复 id：${normalized.id}`);
    }
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizeTrainingRecord(record, index) {
  const label = `第 ${index + 1} 条训练记录`;
  if (!isRecord(record)) {
    throw new TypeError(`${label}必须是对象`);
  }
  if (record.status !== "finished") {
    throw new RangeError(`${label}必须是已结束训练`);
  }

  const id = nonEmptyString(record.id, `${label} id`);
  if (String(record.symbol ?? "").trim().toUpperCase() !== "BTCUSDT") {
    throw new RangeError(`${label}必须是 BTCUSDT 训练`);
  }
  if (!TRAINING_INTERVALS.has(record.interval)) {
    throw new RangeError(`${label}周期无效`);
  }
  const source = nonEmptyString(record.source, `${label}数据来源`);
  const endedAt = normalizeTime(record.endedAt, `${label}结束时间`);
  const recordedAt = normalizeTime(
    record.recordedAt ?? endedAt,
    `${label}记录时间`,
  );
  const windowStartTime = positiveFinite(
    record.windowStartTime,
    `${label}行情开始时间`,
  );
  const windowEndTime = positiveFinite(
    record.windowEndTime,
    `${label}行情结束时间`,
  );
  if (windowEndTime < windowStartTime) {
    throw new RangeError(`${label}行情时间范围无效`);
  }
  const barsViewed = positiveInteger(record.barsViewed, `${label}查看 K 线数量`);
  const actions = record.actions ?? [];
  const riskChanges = record.riskChanges ?? [];
  const limitOrderChanges = record.limitOrderChanges ?? [];
  const limitOrders = record.limitOrders ?? [];
  const markers = record.markers ?? [];
  assertRecordArray(actions, `${label}操作记录`);
  assertRecordArray(riskChanges, `${label}止盈止损记录`);
  assertRecordArray(limitOrderChanges, `${label}限价单记录`);
  assertRecordArray(limitOrders, `${label}未成交限价单`);
  if (limitOrders.length > 0) {
    throw new RangeError(`${label}仍有未成交限价单，不能作为已结束训练导入`);
  }
  if (!Array.isArray(markers)) {
    throw new TypeError(`${label}图表标记必须是数组`);
  }
  const normalizedMarkers = markers.map((marker, markerIndex) =>
    normalizeMarker(marker, `${label}第 ${markerIndex + 1} 个图表标记`));

  // 复用训练领域层对净盈亏、初始资金和结束状态的权威校验。
  calculateTrainingPerformance([record]);

  return {
    ...record,
    id,
    symbol: "BTCUSDT",
    interval: record.interval,
    source,
    endedAt,
    recordedAt,
    windowStartTime,
    windowEndTime,
    barsViewed,
    actions: [...actions],
    riskChanges: [...riskChanges],
    limitOrders: [],
    limitOrderChanges: [...limitOrderChanges],
    markers: normalizedMarkers,
  };
}

function normalizeMarker(marker, label) {
  if (!isRecord(marker)) {
    throw new TypeError(`${label}必须是对象`);
  }
  const direction = marker.direction;
  if (direction !== "buy" && direction !== "sell") {
    throw new RangeError(`${label}方向无效`);
  }
  const normalized = {
    ...marker,
    id: nonEmptyString(marker.id, `${label} id`),
    time: positiveFinite(marker.time, `${label}时间`),
    direction,
    label: nonEmptyString(marker.label, `${label}文字`),
    price: positiveFinite(marker.price, `${label}价格`),
  };
  if (marker.actionId !== undefined) {
    normalized.actionId = nonEmptyString(marker.actionId, `${label}动作 id`);
  }
  return normalized;
}

function assertRecordArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new TypeError(`${label}必须是对象数组`);
  }
}

function normalizeTime(value, label) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(time)) {
    throw new RangeError(`${label}无效`);
  }
  return new Date(time).toISOString();
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}必须是非空字符串`);
  }
  return value.trim();
}

function positiveFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${label}必须大于 0`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = positiveFinite(value, label);
  if (!Number.isInteger(number)) {
    throw new RangeError(`${label}必须是正整数`);
  }
  return number;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
