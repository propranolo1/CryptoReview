import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeTrainingResultRecords,
  parseTrainingResultsImport,
  serializeTrainingResultsExport,
} from "../lib/training-records.mjs";
import {
  createTrainingSession,
  finishTrainingSession,
} from "../lib/training.mjs";

function trainingRecord(overrides = {}) {
  const endedAt = overrides.endedAt ?? "2026-07-16T09:00:00.000Z";
  const session = createTrainingSession({
    id: overrides.id ?? "training-export-1",
    startedAt: "2026-07-16T08:00:00.000Z",
  });
  return {
    ...finishTrainingSession(session, { endedAt }),
    interval: "15m",
    source: "Binance Futures",
    windowStartTime: 1_721_113_200_000,
    windowEndTime: 1_721_116_800_000,
    barsViewed: 5,
    markers: [],
    recordedAt: overrides.recordedAt ?? endedAt,
    ...overrides,
  };
}

test("训练记录导出为带版本号的 JSON，并可完整重新导入", () => {
  const record = trainingRecord({
    mainTimeframe: "1H",
    summary: {
      version: 1,
      netPnl: 0,
      returnRatePercent: 0,
      initialRisk: 100,
      rMultiple: 0,
      mfe: 50,
      mae: -25,
      averageHoldingBars: 2,
      averageHoldingMs: 7_200_000,
      holdingCycleCount: 1,
      addCount: 0,
      reduceCount: 0,
      direction: "long",
      mainTimeframe: "1H",
      excursionBasis: "candle-high-low",
    },
  });
  const output = serializeTrainingResultsExport([record], {
    exportedAt: "2026-07-30T06:00:00.000Z",
  });
  const envelope = JSON.parse(output);

  assert.equal(envelope.type, "cryptoreview-training-results");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.exportedAt, "2026-07-30T06:00:00.000Z");
  assert.deepEqual(parseTrainingResultsImport(output), [record]);
});

test("训练记录导入兼容旧版数组，并拒绝活动会话和未知版本", () => {
  const record = trainingRecord();
  assert.deepEqual(
    parseTrainingResultsImport(JSON.stringify([record])),
    [record],
  );

  assert.throws(
    () => parseTrainingResultsImport(JSON.stringify([
      { ...record, status: "active" },
    ])),
    /必须是已结束训练/,
  );
  assert.throws(
    () => parseTrainingResultsImport(JSON.stringify({
      type: "cryptoreview-training-results",
      version: 2,
      records: [record],
    })),
    /不支持的训练记录版本/,
  );
  assert.throws(
    () => parseTrainingResultsImport("{错误 JSON"),
    /训练记录文件不是有效 JSON/,
  );
});

test("导入训练记录按 id 合并，并保留 recordedAt 较新的版本", () => {
  const current = trainingRecord({
    id: "same-session",
    netPnl: 10,
    recordedAt: "2026-07-30T06:00:00.000Z",
  });
  const older = trainingRecord({
    id: "same-session",
    netPnl: -20,
    recordedAt: "2026-07-29T06:00:00.000Z",
  });
  const newer = trainingRecord({
    id: "same-session",
    netPnl: 30,
    recordedAt: "2026-07-31T06:00:00.000Z",
  });
  const another = trainingRecord({
    id: "another-session",
    endedAt: "2026-07-17T09:00:00.000Z",
    recordedAt: "2026-07-17T09:00:00.000Z",
  });

  assert.deepEqual(
    mergeTrainingResultRecords([current], [older, another]),
    [another, current],
  );
  assert.deepEqual(
    mergeTrainingResultRecords([current], [newer]),
    [newer],
  );
});
