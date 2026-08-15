import type Tesseract from "tesseract.js";
import type { ParsedBasicOrder } from "@/lib/basic-orders.mjs";
import { parseBasicOrdersFromOcrWords } from "@/lib/basic-orders.mjs";
import { preprocessConditionOrderImage } from "@/app/lib/condition-order-ocr";

export type BasicOrderOcrStage =
  | "loading"
  | "preprocessing"
  | "recognizing"
  | "parsing";

export type BasicOrderOcrProgress = {
  stage: BasicOrderOcrStage;
  percent: number;
  currentFile: string | null;
  fileIndex: number;
  fileCount: number;
  message: string;
};

type ProgressCallback = (progress: BasicOrderOcrProgress) => void;

type FlatOcrWord = {
  text: string;
  confidence: number;
  bbox: Tesseract.Bbox;
};

type BasicFieldDefinition = {
  leftRatio: number;
  rightRatio: number;
  label: "direction" | "reduceOnly" | "postOnly" | "status";
  width: number;
  targetLeft: number;
  targetRight: number;
};

const OCR_WORKER_PATH = "/ocr/worker.min.js";
const OCR_CORE_PATH = "/ocr/core";
const OCR_LANGUAGE_PATH = "/ocr/lang";

export async function recognizeBasicOrderImages(
  files: readonly File[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<ParsedBasicOrder[]> {
  if (files.length === 0) return [];
  assertNotAborted(signal);

  let worker: Tesseract.Worker | null = null;
  let currentFileIndex = -1;
  let currentFileName: string | null = null;
  const notify = (
    stage: BasicOrderOcrStage,
    percent: number,
    message: string,
  ) => {
    onProgress({
      stage,
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
    notify("loading", 1, "正在加载本地 OCR 引擎");
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
          const engineProgress = Number.isFinite(message.progress)
            ? message.progress
            : 0;
          if (currentFileIndex < 0) {
            notify(
              "loading",
              2 + engineProgress * 13,
              localizeTesseractStatus(message.status),
            );
            return;
          }
          const completedShare = currentFileIndex / files.length;
          const currentShare = engineProgress / files.length;
          notify(
            "recognizing",
            18 + (completedShare + currentShare) * 77,
            localizeTesseractStatus(message.status),
          );
        },
      },
    );
    assertNotAborted(signal);

    const ordersById = new Map<string, ParsedBasicOrder>();
    for (const [index, file] of files.entries()) {
      assertNotAborted(signal);
      currentFileIndex = index;
      currentFileName = file.name;
      notify(
        "preprocessing",
        15 + (index / files.length) * 78,
        `正在预处理第 ${index + 1} 张基础单截图`,
      );
      const canvas = await preprocessConditionOrderImage(file, signal);
      assertNotAborted(signal);

      await worker.setParameters({
        tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1",
      });
      notify(
        "recognizing",
        18 + (index / files.length) * 78,
        `正在识别第 ${index + 1} 张基础单截图`,
      );
      const result = await worker.recognize(
        canvas,
        {},
        { text: true, blocks: true },
      );
      assertNotAborted(signal);
      const primaryWords = flattenTesseractWords(result.data.blocks);
      notify(
        "recognizing",
        18 + ((index + 0.78) / files.length) * 78,
        `正在补全第 ${index + 1} 张截图中的方向与状态`,
      );
      const recoveredWords = await recoverBasicOrderFields(
        worker,
        canvas,
        primaryWords,
        tesseract.PSM.SINGLE_LINE,
        signal,
      );
      assertNotAborted(signal);
      notify(
        "parsing",
        18 + ((index + 0.96) / files.length) * 78,
        `正在解析第 ${index + 1} 张基础单截图`,
      );
      const parsed = parseBasicOrdersFromOcrWords(
        [...primaryWords, ...recoveredWords],
        canvas.width,
      );
      for (const order of parsed) {
        ordersById.delete(order.orderId);
        ordersById.set(order.orderId, order);
      }
    }

    notify("parsing", 100, "基础单本地识别完成");
    return [...ordersById.values()].sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.orderId.localeCompare(right.orderId),
    );
  } finally {
    signal?.removeEventListener("abort", abortWorker);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

export async function recoverBasicOrderFields(
  worker: Tesseract.Worker,
  source: HTMLCanvasElement,
  primaryWords: readonly FlatOcrWord[],
  singleLinePsm: Tesseract.PSM,
  signal?: AbortSignal,
): Promise<FlatOcrWord[]> {
  const rowCenters = findBasicOrderRowCenters(primaryWords);
  if (rowCenters.length === 0) return [];

  const recovered: FlatOcrWord[] = [];
  await worker.setParameters({
    tessedit_pageseg_mode: singleLinePsm,
    preserve_interword_spaces: "1",
  });
  for (const [index, rowCenter] of rowCenters.entries()) {
    assertNotAborted(signal);
    const previous = rowCenters[index - 1];
    const next = rowCenters[index + 1];
    const top = previous
      ? (previous + rowCenter) / 2
      : Math.max(0, rowCenter - 48);
    const bottom = next
      ? (rowCenter + next) / 2
      : Math.min(source.height, rowCenter + 48);
    const crop = createRowFieldsCrop(source, top, bottom);
    const result = await worker.recognize(
      crop.canvas,
      {},
      { text: true, blocks: true },
    );
    assertNotAborted(signal);
    for (const word of flattenTesseractWords(result.data.blocks)) {
      const center = (word.bbox.x0 + word.bbox.x1) / 2;
      const field = crop.fields.find((candidate) =>
        center >= candidate.targetLeft && center < candidate.targetRight,
      );
      if (!field) continue;
      const centerX = source.width * ((field.leftRatio + field.rightRatio) / 2);
      recovered.push({
        text: word.text,
        confidence: word.confidence,
        bbox: {
          x0: centerX - 20,
          y0: rowCenter,
          x1: centerX + 20,
          y1: rowCenter + 20,
        },
      });
    }
  }
  return recovered;
}

function flattenTesseractWords(
  blocks: Tesseract.Block[] | null,
): FlatOcrWord[] {
  if (!blocks) return [];
  return blocks.flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.flatMap((line) =>
        line.words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          bbox: word.bbox,
        })),
      ),
    ),
  );
}

function findBasicOrderRowCenters(words: readonly FlatOcrWord[]) {
  return words
    .filter((word) => /^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/i.test(
      word.text.replace(/[^A-Z0-9]/gi, ""),
    ))
    .map((word) => (word.bbox.y0 + word.bbox.y1) / 2)
    .sort((left, right) => left - right)
    .filter((center, index, all) =>
      index === 0 || center - all[index - 1] > 24,
    );
}

function createRowFieldsCrop(
  source: HTMLCanvasElement,
  rawTop: number,
  rawBottom: number,
) {
  const definitions = [
    [0.245, 0.325, "direction"],
    [0.68, 0.755, "reduceOnly"],
    [0.755, 0.84, "postOnly"],
    [0.92, 1, "status"],
  ] as const;
  const scale = 3;
  const gap = 80;
  const top = Math.max(0, Math.floor(rawTop));
  const height = Math.max(
    1,
    Math.min(source.height - top, Math.ceil(rawBottom) - top),
  );
  const targetHeight = height * scale;
  const fields: BasicFieldDefinition[] = definitions.map(
    ([leftRatio, rightRatio, label]) => ({
      leftRatio,
      rightRatio,
      label,
      width: Math.ceil(source.width * (rightRatio - leftRatio) * scale),
      targetLeft: 0,
      targetRight: 0,
    }),
  );
  let targetLeft = 0;
  for (const field of fields) {
    field.targetLeft = targetLeft;
    field.targetRight = targetLeft + field.width;
    targetLeft = field.targetRight + gap;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, targetLeft - gap);
  canvas.height = targetHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前设备无法创建基础单字段补充识别画布");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  for (const field of fields) {
    const left = Math.floor(source.width * field.leftRatio);
    const width = Math.ceil(source.width * (field.rightRatio - field.leftRatio));
    context.drawImage(
      source,
      left,
      top,
      width,
      height,
      field.targetLeft,
      0,
      field.width,
      targetHeight,
    );
    normalizeRegion(
      context,
      field.targetLeft,
      0,
      field.width,
      targetHeight,
    );
  }
  return { canvas, fields };
}

function normalizeRegion(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const imageData = context.getImageData(left, top, width, height);
  const values = new Uint8ClampedArray(width * height);
  let minimum = 255;
  let maximum = 0;
  for (let pixel = 0; pixel < values.length; pixel += 1) {
    const offset = pixel * 4;
    const value = imageData.data[offset];
    values[pixel] = value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const range = Math.max(1, maximum - minimum);
  for (let pixel = 0; pixel < values.length; pixel += 1) {
    const offset = pixel * 4;
    const value = Math.round(((values[pixel] - minimum) / range) * 255);
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }
  context.putImageData(imageData, left, top);
}

function localizeTesseractStatus(status: string) {
  const labels: Record<string, string> = {
    "loading tesseract core": "正在加载本地识别核心",
    "initializing tesseract": "正在初始化本地识别核心",
    "loading language traineddata": "正在加载本地中英文模型",
    "initializing api": "正在初始化中英文识别",
    "recognizing text": "正在识别基础单截图",
  };
  return labels[status] ?? "正在本地识别基础单";
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("识别已取消", "AbortError");
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
