import { randomUUID as defaultRandomUUID } from "node:crypto";
import { open as defaultOpenFile, rm as defaultRemoveFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

export const VIDEO_EXPORT_LIMITS = Object.freeze({
  maxChunkBytes: 32 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
});

const VIDEO_FORMATS = Object.freeze({
  "video/mp4": {
    extension: ".mp4",
    filterName: "MP4 视频",
  },
  "video/webm": {
    extension: ".webm",
    filterName: "WebM 视频",
  },
});

/**
 * 通过受限的 begin/append/complete 生命周期把渲染进程生成的视频分块写入磁盘。
 * 服务始终只保留一个打开的文件，任何中断或异常都会尝试删除半成品。
 */
export function createVideoExportService({
  dialog,
  openFile = defaultOpenFile,
  removeFile = (filePath) => defaultRemoveFile(filePath, { force: true }),
  randomUUID = defaultRandomUUID,
}) {
  if (!dialog || typeof dialog.showSaveDialog !== "function") {
    throw new TypeError("系统保存对话框不可用");
  }
  if (typeof openFile !== "function") {
    throw new TypeError("视频文件写入接口不可用");
  }
  if (typeof removeFile !== "function") {
    throw new TypeError("视频文件清理接口不可用");
  }
  if (typeof randomUUID !== "function") {
    throw new TypeError("视频导出任务编号生成器不可用");
  }

  let activeTask = null;
  let beginPending = false;
  let disposed = false;

  function assertAvailable() {
    if (disposed) throw new Error("视频导出服务已经关闭");
  }

  function getActiveTask(exportId) {
    if (typeof exportId !== "string" || exportId.trim() === "") {
      throw new TypeError("视频导出任务编号无效");
    }
    if (!activeTask || activeTask.id !== exportId) {
      throw new Error("视频导出任务不匹配或已经结束");
    }
    return activeTask;
  }

  async function cleanupPartial(task) {
    if (task.cleanupPromise) return task.cleanupPromise;

    task.cleanupPromise = (async () => {
      const failures = [];
      if (!task.closed) {
        try {
          await task.handle.close();
          task.closed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await removeFile(task.filePath);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "无法完整清理未完成的视频文件");
      }
    })();

    return task.cleanupPromise;
  }

  function detachTask(task, state) {
    task.state = state;
    if (activeTask === task) activeTask = null;
  }

  async function rejectAndCleanup(task, error, { waitForQueue = false } = {}) {
    detachTask(task, "failed");
    if (waitForQueue) {
      await task.queue.catch(() => {});
    }
    try {
      await cleanupPartial(task);
    } catch (cleanupError) {
      throw new Error(`${error.message}；同时无法完整清理半成品`, {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }

  return {
    async begin(options) {
      assertAvailable();
      if (beginPending || activeTask) {
        throw new Error("已有视频正在导出，请先完成或取消当前任务");
      }

      const { mimeType, format } = normalizeMimeType(options?.mimeType);
      const suggestedName = normalizeSuggestedName(
        options?.suggestedName,
        format.extension,
      );

      beginPending = true;
      let selectedPath = null;
      let handle = null;

      try {
        const result = await dialog.showSaveDialog({
          title: "导出交易复盘视频",
          defaultPath: suggestedName,
          buttonLabel: "保存视频",
          filters: [
            {
              name: format.filterName,
              extensions: [format.extension.slice(1)],
            },
          ],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });

        if (result?.canceled) return { canceled: true };
        assertAvailable();
        selectedPath = normalizeSelectedPath(result?.filePath, format.extension);
        handle = await openFile(selectedPath, "w");
        validateFileHandle(handle);

        if (disposed) {
          const abandonedTask = createTask({
            id: "disposed",
            filePath: selectedPath,
            mimeType,
            handle,
          });
          await cleanupPartial(abandonedTask);
          handle = null;
          selectedPath = null;
          throw new Error("视频导出服务已经关闭");
        }

        const id = normalizeExportId(randomUUID());
        activeTask = createTask({
          id,
          filePath: selectedPath,
          mimeType,
          handle,
        });

        return {
          canceled: false,
          exportId: id,
          filePath: selectedPath,
          mimeType,
        };
      } catch (error) {
        if (handle && selectedPath && !activeTask) {
          const abandonedTask = createTask({
            id: "begin-failed",
            filePath: selectedPath,
            mimeType,
            handle,
          });
          try {
            await cleanupPartial(abandonedTask);
          } catch (cleanupError) {
            throw new Error(`${error.message}；同时无法完整清理半成品`, {
              cause: new AggregateError([error, cleanupError]),
            });
          }
        } else if (selectedPath && !handle) {
          await removeFile(selectedPath).catch(() => {});
        }
        throw error;
      } finally {
        beginPending = false;
      }
    },

    async append(input) {
      assertAvailable();
      const task = getActiveTask(input?.exportId);
      if (task.state !== "active") {
        throw new Error("视频导出任务当前不可写入");
      }

      let bytes;
      let totalAfterAppend;
      try {
        bytes = normalizeChunk(input?.chunk);
        if (bytes.byteLength > VIDEO_EXPORT_LIMITS.maxChunkBytes) {
          throw new RangeError(
            `单个视频分块不得超过 ${VIDEO_EXPORT_LIMITS.maxChunkBytes} 字节`,
          );
        }
        totalAfterAppend = task.totalBytes + bytes.byteLength;
        if (totalAfterAppend > VIDEO_EXPORT_LIMITS.maxTotalBytes) {
          throw new RangeError(
            `视频文件总大小不得超过 ${VIDEO_EXPORT_LIMITS.maxTotalBytes} 字节`,
          );
        }
        task.totalBytes = totalAfterAppend;
      } catch (error) {
        return rejectAndCleanup(task, error, { waitForQueue: true });
      }

      const writeOperation = task.queue.then(() => writeFully(task.handle, bytes));
      task.queue = writeOperation;

      try {
        await writeOperation;
        return {
          exportId: task.id,
          bytesWritten: bytes.byteLength,
          totalBytes: totalAfterAppend,
        };
      } catch (error) {
        return rejectAndCleanup(task, error);
      }
    },

    async complete(exportId) {
      assertAvailable();
      const task = getActiveTask(exportId);
      if (task.state !== "active") {
        throw new Error("视频导出任务当前无法完成");
      }
      task.state = "completing";

      try {
        await task.queue;
        if (task.totalBytes === 0) {
          throw new Error("视频没有可保存的数据");
        }
        await task.handle.close();
        task.closed = true;
        detachTask(task, "completed");
        return {
          exportId: task.id,
          filePath: task.filePath,
          mimeType: task.mimeType,
          bytesWritten: task.totalBytes,
        };
      } catch (error) {
        return rejectAndCleanup(task, error);
      }
    },

    async cancel(exportId) {
      assertAvailable();
      const task = getActiveTask(exportId);
      detachTask(task, "canceling");
      await task.queue.catch(() => {});
      await cleanupPartial(task);
      task.state = "canceled";
      return { canceled: true, exportId: task.id };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const task = activeTask;
      if (!task) return;
      detachTask(task, "disposing");
      await task.queue.catch(() => {});
      await cleanupPartial(task);
      task.state = "disposed";
    },
  };
}

function createTask({ id, filePath, mimeType, handle }) {
  return {
    id,
    filePath,
    mimeType,
    handle,
    totalBytes: 0,
    queue: Promise.resolve(),
    cleanupPromise: null,
    closed: false,
    state: "active",
  };
}

function normalizeMimeType(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new TypeError("视频格式必须是 MP4 或 WebM");
  }
  const mimeType = value.split(";", 1)[0].trim().toLowerCase();
  const format = VIDEO_FORMATS[mimeType];
  if (!format) throw new TypeError("视频格式必须是 MP4 或 WebM");
  return { mimeType, format };
}

function normalizeSuggestedName(value, expectedExtension) {
  if (typeof value !== "string") throw new TypeError("视频文件名无效");
  let fileName = value.trim();
  if (
    fileName === "" ||
    fileName.length > 200 ||
    fileName === "." ||
    fileName === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(fileName) ||
    /[. ]$/u.test(fileName)
  ) {
    throw new TypeError("视频文件名包含无效字符");
  }

  const currentExtension = extname(fileName).toLowerCase();
  if (currentExtension === "") {
    fileName += expectedExtension;
  } else if (currentExtension !== expectedExtension) {
    throw new TypeError(`视频文件名必须使用 ${expectedExtension} 扩展名`);
  }

  const stem = fileName.slice(0, -expectedExtension.length);
  const windowsStem = stem.split(".", 1)[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(windowsStem)) {
    throw new TypeError("视频文件名是系统保留名称");
  }
  return fileName;
}

function normalizeSelectedPath(value, expectedExtension) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("没有选择有效的视频保存位置");
  }
  let filePath = value.trim();
  if (!isAbsolute(filePath)) throw new Error("视频保存位置必须是绝对路径");
  const currentExtension = extname(filePath).toLowerCase();
  if (currentExtension === "") {
    filePath += expectedExtension;
  } else if (currentExtension !== expectedExtension) {
    throw new Error(`视频保存位置必须使用 ${expectedExtension} 扩展名`);
  }
  return filePath;
}

function normalizeExportId(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new Error("无法生成有效的视频导出任务编号");
  }
  return value;
}

function validateFileHandle(handle) {
  if (
    !handle ||
    typeof handle.write !== "function" ||
    typeof handle.close !== "function"
  ) {
    throw new TypeError("无法打开视频保存文件");
  }
}

function normalizeChunk(chunk) {
  if (chunk instanceof Uint8Array) {
    if (chunk.byteLength === 0) throw new TypeError("视频分块不能为空");
    return Uint8Array.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    if (chunk.byteLength === 0) throw new TypeError("视频分块不能为空");
    return new Uint8Array(chunk.slice(0));
  }
  throw new TypeError("视频分块必须是 Uint8Array 或 ArrayBuffer");
}

async function writeFully(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    const bytesWritten = Number(result?.bytesWritten);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > bytes.byteLength - offset
    ) {
      throw new Error("视频文件写入不完整");
    }
    offset += bytesWritten;
  }
}
