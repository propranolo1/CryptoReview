import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_EXPORT_LIMITS,
  createVideoExportService,
} from "../desktop/video-export-service.mjs";

function createHarness({
  canceled = false,
  filePath = "C:\\exports\\BTCUSDT-复盘.webm",
  writeDelay = 0,
  failWriteAt = -1,
} = {}) {
  const writes = [];
  const removed = [];
  let closeCount = 0;
  let writeCount = 0;

  const handle = {
    async write(bytes, offset = 0, length = bytes.byteLength - offset) {
      const callIndex = writeCount++;
      if (writeDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, writeDelay));
      }
      if (callIndex === failWriteAt) throw new Error("磁盘写入失败");
      const value = Uint8Array.from(bytes.subarray(offset, offset + length));
      writes.push(value);
      return { bytesWritten: value.byteLength, buffer: bytes };
    },
    async close() {
      closeCount += 1;
    },
  };

  const service = createVideoExportService({
    dialog: {
      async showSaveDialog(options) {
        return { canceled, filePath: canceled ? undefined : filePath, options };
      },
    },
    async openFile(selectedPath, flags) {
      assert.equal(selectedPath, filePath);
      assert.equal(flags, "w");
      return handle;
    },
    async removeFile(selectedPath) {
      removed.push(selectedPath);
    },
    randomUUID: () => "export-uuid",
  });

  return {
    service,
    writes,
    removed,
    get closeCount() {
      return closeCount;
    },
  };
}

test("视频分块按调用顺序流式写入并在完成时关闭文件", async () => {
  const harness = createHarness({ writeDelay: 5 });
  const beginResult = await harness.service.begin({
    suggestedName: "BTCUSDT-复盘.webm",
    mimeType: "video/webm;codecs=vp9",
  });

  assert.deepEqual(beginResult, {
    canceled: false,
    exportId: "export-uuid",
    filePath: "C:\\exports\\BTCUSDT-复盘.webm",
    mimeType: "video/webm",
  });

  await Promise.all([
    harness.service.append({
      exportId: beginResult.exportId,
      chunk: Uint8Array.from([1, 2]),
    }),
    harness.service.append({
      exportId: beginResult.exportId,
      chunk: Uint8Array.from([3, 4]).buffer,
    }),
  ]);

  const completed = await harness.service.complete(beginResult.exportId);
  assert.deepEqual(
    harness.writes.map((chunk) => [...chunk]),
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.deepEqual(completed, {
    exportId: "export-uuid",
    filePath: "C:\\exports\\BTCUSDT-复盘.webm",
    mimeType: "video/webm",
    bytesWritten: 4,
  });
  assert.equal(harness.closeCount, 1);
  assert.deepEqual(harness.removed, []);
});

test("用户取消与写入异常都会清理半成品", async () => {
  const canceledHarness = createHarness({ canceled: true });
  assert.deepEqual(
    await canceledHarness.service.begin({
      suggestedName: "BTCUSDT.mp4",
      mimeType: "video/mp4",
    }),
    { canceled: true },
  );

  const manualHarness = createHarness();
  const manual = await manualHarness.service.begin({
    suggestedName: "BTCUSDT.webm",
    mimeType: "video/webm",
  });
  await manualHarness.service.append({
    exportId: manual.exportId,
    chunk: Uint8Array.from([1]),
  });
  assert.deepEqual(await manualHarness.service.cancel(manual.exportId), {
    canceled: true,
    exportId: manual.exportId,
  });
  assert.equal(manualHarness.closeCount, 1);
  assert.deepEqual(manualHarness.removed, ["C:\\exports\\BTCUSDT-复盘.webm"]);

  const failedHarness = createHarness({ failWriteAt: 0 });
  const failed = await failedHarness.service.begin({
    suggestedName: "BTCUSDT.webm",
    mimeType: "video/webm",
  });
  await assert.rejects(
    failedHarness.service.append({
      exportId: failed.exportId,
      chunk: Uint8Array.from([9]),
    }),
    /磁盘写入失败/,
  );
  assert.equal(failedHarness.closeCount, 1);
  assert.deepEqual(failedHarness.removed, ["C:\\exports\\BTCUSDT-复盘.webm"]);
});

test("只允许一个导出任务，并严格校验格式、文件名、任务和分块", async () => {
  const harness = createHarness();
  const active = await harness.service.begin({
    suggestedName: "BTCUSDT.webm",
    mimeType: "video/webm",
  });

  await assert.rejects(
    harness.service.begin({
      suggestedName: "SOLUSDT.mp4",
      mimeType: "video/mp4",
    }),
    /已有视频正在导出/,
  );
  await assert.rejects(
    harness.service.append({
      exportId: "other-export",
      chunk: Uint8Array.from([1]),
    }),
    /导出任务不匹配/,
  );
  await assert.rejects(
    harness.service.append({
      exportId: active.exportId,
      chunk: "not-binary",
    }),
    /Uint8Array 或 ArrayBuffer/,
  );
  assert.deepEqual(harness.removed, ["C:\\exports\\BTCUSDT-复盘.webm"]);

  const invalidHarness = createHarness();
  await assert.rejects(
    invalidHarness.service.begin({
      suggestedName: "..\\BTCUSDT.webm",
      mimeType: "video/webm",
    }),
    /文件名/,
  );
  await assert.rejects(
    invalidHarness.service.begin({
      suggestedName: "BTCUSDT.mov",
      mimeType: "video/quicktime",
    }),
    /MP4 或 WebM/,
  );
});

test("超过单块或累计大小限制时拒绝写入并删除半成品", async () => {
  const harness = createHarness();
  const active = await harness.service.begin({
    suggestedName: "BTCUSDT.webm",
    mimeType: "video/webm",
  });

  await assert.rejects(
    harness.service.append({
      exportId: active.exportId,
      chunk: new Uint8Array(VIDEO_EXPORT_LIMITS.maxChunkBytes + 1),
    }),
    /单个视频分块/,
  );
  assert.deepEqual(harness.removed, ["C:\\exports\\BTCUSDT-复盘.webm"]);
});
