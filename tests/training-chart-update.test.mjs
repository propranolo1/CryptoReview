import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTrainingSeriesUpdate,
  createTrainingSeriesCursor,
} from "../lib/training-chart-update.mjs";

function candle(time, close = 100) {
  return {
    time,
    open: 99,
    high: Math.max(101, close),
    low: 98,
    close,
    volume: 10,
  };
}

test("训练图表只在新序列时整批初始化", () => {
  const candles = [candle(1), candle(2)];
  const initial = classifyTrainingSeriesUpdate(null, "session:15m", candles);
  assert.equal(initial.mode, "reset");

  const switched = classifyTrainingSeriesUpdate(
    initial.cursor,
    "session:1H",
    candles,
  );
  assert.equal(switched.mode, "reset");
});

test("训练操作不改变行情时跳过，下一根使用追加更新", () => {
  const candles = [candle(1), candle(2)];
  const previous = createTrainingSeriesCursor("session:15m", candles);

  assert.equal(
    classifyTrainingSeriesUpdate(previous, "session:15m", [...candles]).mode,
    "none",
  );
  assert.equal(
    classifyTrainingSeriesUpdate(
      previous,
      "session:15m",
      [...candles, candle(3)],
    ).mode,
    "append",
  );
});

test("高周期形成中的最后一根只使用 update 更新", () => {
  const candles = [candle(1), candle(2)];
  const previous = createTrainingSeriesCursor("session:4H", candles);
  const updated = [candles[0], candle(2, 105)];

  assert.equal(
    classifyTrainingSeriesUpdate(previous, "session:4H", updated).mode,
    "update-last",
  );
});
