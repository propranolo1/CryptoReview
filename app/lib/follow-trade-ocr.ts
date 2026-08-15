import type Tesseract from "tesseract.js";
import {
  parseFollowTradeTimelineText,
  type FollowTradeEvent,
} from "@/lib/follow-trade-records.mjs";
import { preprocessConditionOrderImage } from "@/app/lib/condition-order-ocr";

export type FollowTradeOcrProgress = {
  percent: number;
  currentFile: string | null;
  fileIndex: number;
  fileCount: number;
  message: string;
};

type ProgressCallback = (progress: FollowTradeOcrProgress) => void;

const OCR_WORKER_PATH = "/ocr/worker.min.js";
const OCR_CORE_PATH = "/ocr/core";
const OCR_LANGUAGE_PATH = "/ocr/lang";

export async function recognizeFollowTradeImages(
  files: readonly File[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<FollowTradeEvent[]> {
  if (files.length === 0) return [];
  assertNotAborted(signal);

  let worker: Tesseract.Worker | null = null;
  let currentFileIndex = -1;
  let currentFileName: string | null = null;
  const notify = (percent: number, message: string) => {
    onProgress({
      percent: clampPercent(percent),
      currentFile: currentFileName,
      fileIndex: currentFileIndex < 0 ? 0 : currentFileIndex + 1,
      fileCount: files.length,
      message,
    });
  };
  const abortWorker = () => {
    if (worker) void worker.terminate();
  };
  signal?.addEventListener("abort", abortWorker, { once: true });

  try {
    notify(1, "正在加载本地 OCR 引擎");
    const tesseract = await import("tesseract.js");
    worker = await tesseract.createWorker(
      ["chi_sim", "eng"],
      tesseract.OEM.LSTM_ONLY,
      {
        workerPath: OCR_WORKER_PATH,
        corePath: OCR_CORE_PATH,
        langPath: OCR_LANGUAGE_PATH,
        workerBlobURL: false,
        gzip: true,
        logger: (message) => {
          const engineProgress = Number.isFinite(message.progress) ? message.progress : 0;
          if (currentFileIndex < 0) {
            notify(2 + engineProgress * 13, localizeStatus(message.status));
            return;
          }
          const completedShare = currentFileIndex / files.length;
          const currentShare = engineProgress / files.length;
          notify(
            18 + (completedShare + currentShare) * 78,
            localizeStatus(message.status),
          );
        },
      },
    );
    assertNotAborted(signal);
    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
    });

    const events = new Map<string, FollowTradeEvent>();
    for (const [index, file] of files.entries()) {
      currentFileIndex = index;
      currentFileName = file.name;
      notify(16 + (index / files.length) * 78, `正在预处理第 ${index + 1} 张跟单记录`);
      const canvas = await preprocessConditionOrderImage(file, signal);
      assertNotAborted(signal);
      notify(18 + (index / files.length) * 78, `正在识别第 ${index + 1} 张跟单记录`);
      const result = await worker.recognize(canvas, {}, { text: true });
      assertNotAborted(signal);
      notify(18 + ((index + 0.96) / files.length) * 78, "正在解析开平仓时间线");
      for (const event of parseFollowTradeTimelineText(result.data.text)) {
        events.set(event.id, event);
      }
    }
    notify(100, "跟单记录本地识别完成");
    return [...events.values()].sort((left, right) =>
      Date.parse(left.time) - Date.parse(right.time) ||
      left.id.localeCompare(right.id));
  } finally {
    signal?.removeEventListener("abort", abortWorker);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

function localizeStatus(status: string) {
  const labels: Record<string, string> = {
    "loading tesseract core": "正在加载本地识别核心",
    "initializing tesseract": "正在初始化本地识别核心",
    "loading language traineddata": "正在加载本地中英文模型",
    "initializing api": "正在初始化中英文识别",
    "recognizing text": "正在识别跟单记录截图",
  };
  return labels[status] ?? "正在本地识别跟单记录";
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("识别已取消", "AbortError");
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
