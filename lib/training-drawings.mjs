const TIMEFRAME_SECONDS = Object.freeze({
  "15m": 15 * 60,
  "1H": 60 * 60,
  "4H": 4 * 60 * 60,
  "1D": 24 * 60 * 60,
});

function getTimeframeSeconds(timeframe) {
  const intervalSeconds = TIMEFRAME_SECONDS[timeframe];
  if (!intervalSeconds) {
    throw new RangeError("不支持的训练绘图时间框架");
  }
  return intervalSeconds;
}

export function getTrainingDrawingBucketRange({
  startTime,
  endTime,
  timeframe,
}) {
  const intervalSeconds = getTimeframeSeconds(timeframe);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new TypeError("训练绘图时间必须是有效秒级时间戳");
  }

  const earlier = Math.min(startTime, endTime);
  const later = Math.max(startTime, endTime);
  return {
    startTime: Math.floor(earlier / intervalSeconds) * intervalSeconds,
    endTime: Math.floor(later / intervalSeconds) * intervalSeconds,
    intervalSeconds,
  };
}

export function getTrainingDrawingTimeAtLogicalIndex({
  candles,
  logicalIndex,
  timeframe,
}) {
  const intervalSeconds = getTimeframeSeconds(timeframe);
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError("训练绘图至少需要一根 K 线");
  }
  if (!Number.isFinite(logicalIndex)) {
    throw new TypeError("训练绘图逻辑位置必须有效");
  }
  const firstTime = Number(candles[0]?.time);
  if (!Number.isFinite(firstTime)) {
    throw new TypeError("训练绘图 K 线时间必须有效");
  }
  return firstTime + Math.round(logicalIndex) * intervalSeconds;
}

export function getTrainingDrawingLogicalIndex({
  candles,
  time,
  timeframe,
}) {
  const intervalSeconds = getTimeframeSeconds(timeframe);
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new RangeError("训练绘图至少需要一根 K 线");
  }
  if (!Number.isFinite(time)) {
    throw new TypeError("训练绘图时间必须有效");
  }
  const firstTime = Number(candles[0]?.time);
  if (!Number.isFinite(firstTime)) {
    throw new TypeError("训练绘图 K 线时间必须有效");
  }
  return (time - firstTime) / intervalSeconds;
}

const RECTANGLE_CORNERS = new Set([
  "topLeft",
  "topRight",
  "bottomLeft",
  "bottomRight",
]);

function assertRectangle(rectangle) {
  if (
    !rectangle ||
    !Number.isFinite(rectangle.startTime) ||
    !Number.isFinite(rectangle.endTime) ||
    !Number.isFinite(rectangle.topPrice) ||
    !Number.isFinite(rectangle.bottomPrice)
  ) {
    throw new TypeError("训练矩形坐标必须有效");
  }
}

export function moveTrainingRectangle(rectangle, {
  timeDelta,
  priceDelta,
}) {
  assertRectangle(rectangle);
  if (!Number.isFinite(timeDelta) || !Number.isFinite(priceDelta)) {
    throw new TypeError("训练矩形偏移量必须有效");
  }
  return {
    ...rectangle,
    startTime: rectangle.startTime + timeDelta,
    endTime: rectangle.endTime + timeDelta,
    topPrice: rectangle.topPrice + priceDelta,
    bottomPrice: rectangle.bottomPrice + priceDelta,
  };
}

export function resizeTrainingRectangle(rectangle, corner, point) {
  assertRectangle(rectangle);
  if (!RECTANGLE_CORNERS.has(corner)) {
    throw new RangeError("不支持的训练矩形角点");
  }
  if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.price)) {
    throw new TypeError("训练矩形角点坐标必须有效");
  }

  const movesLeft = corner === "topLeft" || corner === "bottomLeft";
  const movesTop = corner === "topLeft" || corner === "topRight";
  const left = movesLeft ? point.time : rectangle.startTime;
  const right = movesLeft ? rectangle.endTime : point.time;
  const top = movesTop ? point.price : rectangle.topPrice;
  const bottom = movesTop ? rectangle.bottomPrice : point.price;
  return {
    ...rectangle,
    startTime: Math.min(left, right),
    endTime: Math.max(left, right),
    topPrice: Math.max(top, bottom),
    bottomPrice: Math.min(top, bottom),
  };
}
