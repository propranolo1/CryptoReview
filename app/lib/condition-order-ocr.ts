import type Tesseract from "tesseract.js";
import type { ParsedConditionalOrder } from "@/lib/conditional-orders.mjs";
import { parseConditionOrdersFromOcrWords } from "@/lib/conditional-orders.mjs";

export type ConditionOcrStage =
  | "loading"
  | "preprocessing"
  | "recognizing"
  | "parsing";

export type ConditionOcrProgress = {
  stage: ConditionOcrStage;
  percent: number;
  currentFile: string | null;
  fileIndex: number;
  fileCount: number;
  message: string;
};

type ProgressCallback = (progress: ConditionOcrProgress) => void;

type FlatOcrWord = {
  text: string;
  confidence: number;
  bbox: Tesseract.Bbox;
};

const OCR_WORKER_PATH = "/ocr/worker.min.js";
const OCR_CORE_PATH = "/ocr/core";
const OCR_LANGUAGE_PATH = "/ocr/lang";

export async function recognizeConditionOrderImages(
  files: readonly File[],
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<ParsedConditionalOrder[]> {
  if (files.length === 0) return [];
  assertNotAborted(signal);

  let worker: Tesseract.Worker | null = null;
  let currentFileIndex = -1;
  let currentFileName: string | null = null;
  const notify = (
    stage: ConditionOcrStage,
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
              2 + engineProgress * 14,
              localizeTesseractStatus(message.status),
            );
            return;
          }
          const completedShare = currentFileIndex / files.length;
          const currentShare = engineProgress / files.length;
          notify(
            "recognizing",
            18 + (completedShare + currentShare) * 78,
            localizeTesseractStatus(message.status),
          );
        },
      },
    );
    assertNotAborted(signal);
    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
    });

    const ordersById = new Map<string, ParsedConditionalOrder>();
    for (const [index, file] of files.entries()) {
      assertNotAborted(signal);
      currentFileIndex = index;
      currentFileName = file.name;
      notify(
        "preprocessing",
        16 + (index / files.length) * 78,
        `正在预处理第 ${index + 1} 张图片`,
      );
      const canvas = await preprocessConditionOrderImage(file, signal);
      assertNotAborted(signal);
      notify(
        "recognizing",
        18 + (index / files.length) * 78,
        `正在识别第 ${index + 1} 张图片`,
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
        18 + ((index + 0.9) / files.length) * 78,
        `正在补全第 ${index + 1} 张图片中的低对比度时间`,
      );
      const words = await recoverMissingDateRows(
        worker,
        canvas,
        primaryWords,
        tesseract.PSM.SINGLE_BLOCK,
        tesseract.PSM.SPARSE_TEXT,
        signal,
      );
      notify(
        "parsing",
        18 + ((index + 0.96) / files.length) * 78,
        `正在解析第 ${index + 1} 张图片`,
      );
      const parsed = parseConditionOrdersFromOcrWords(words, canvas.width);
      for (const order of parsed) {
        ordersById.delete(order.id);
        ordersById.set(order.id, order);
      }
    }

    notify("parsing", 100, "本地识别完成");
    return [...ordersById.values()].sort((left, right) =>
      Date.parse(left.createdTime) - Date.parse(right.createdTime) ||
      left.id.localeCompare(right.id),
    );
  } finally {
    signal?.removeEventListener("abort", abortWorker);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

export async function preprocessConditionOrderImage(
  file: File,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  if (!file.type.startsWith("image/")) {
    throw new TypeError(`${file.name || "所选文件"}不是支持的图片格式`);
  }
  assertNotAborted(signal);

  const decoded = await decodeImage(file);
  try {
    assertNotAborted(signal);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * 2));
    canvas.height = Math.max(1, Math.round(decoded.height * 2));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前设备无法创建图片处理画布");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const normalized = normalizeNegatedGrayscale(imageData.data);
    const sharpened = sharpenGrayscale(normalized, canvas.width, canvas.height);

    for (let pixel = 0; pixel < sharpened.length; pixel += 1) {
      const offset = pixel * 4;
      const value = sharpened[pixel];
      imageData.data[offset] = value;
      imageData.data[offset + 1] = value;
      imageData.data[offset + 2] = value;
      imageData.data[offset + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    return canvas;
  } finally {
    decoded.dispose();
  }
}

function flattenTesseractWords(blocks: Tesseract.Block[] | null): FlatOcrWord[] {
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

async function recoverMissingDateRows(
  worker: Tesseract.Worker,
  source: HTMLCanvasElement,
  words: readonly FlatOcrWord[],
  singleBlockPsm: Tesseract.PSM,
  sparseTextPsm: Tesseract.PSM,
  signal?: AbortSignal,
): Promise<FlatOcrWord[]> {
  const missingRows = findSymbolRows(words, source.height)
    .filter((row) => !rowHasDate(words, row.top, row.bottom))
    .slice(0, 12);
  if (missingRows.length === 0) return [...words];

  const recovered: FlatOcrWord[] = [];
  await worker.setParameters({
    tessedit_pageseg_mode: singleBlockPsm,
    preserve_interword_spaces: "1",
  });
  try {
    for (const row of missingRows) {
      assertNotAborted(signal);
      const crop = createDateRowCrop(source, row.top, row.bottom);
      const result = await worker.recognize(
        crop.canvas,
        {},
        { text: true, blocks: true },
      );
      assertNotAborted(signal);
      for (const word of flattenTesseractWords(result.data.blocks)) {
        recovered.push({
          ...word,
          bbox: {
            x0: crop.left + word.bbox.x0 / crop.scale,
            y0: crop.top + word.bbox.y0 / crop.scale,
            x1: crop.left + word.bbox.x1 / crop.scale,
            y1: crop.top + word.bbox.y1 / crop.scale,
          },
        });
      }
    }
  } finally {
    if (!signal?.aborted) {
      await worker.setParameters({
        tessedit_pageseg_mode: sparseTextPsm,
        preserve_interword_spaces: "1",
      }).catch(() => undefined);
    }
  }
  return [...words, ...recovered];
}

function findSymbolRows(words: readonly FlatOcrWord[], imageHeight: number) {
  const centers = words
    .filter((word) => /^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/i.test(
      word.text.replace(/[^A-Z0-9]/gi, ""),
    ))
    .map((word) => (word.bbox.y0 + word.bbox.y1) / 2)
    .sort((left, right) => left - right)
    .filter((center, index, all) => index === 0 || center - all[index - 1] > 24);
  if (centers.length === 0) return [];
  const gaps = centers
    .slice(1)
    .map((center, index) => center - centers[index])
    .filter((gap) => gap > 24);
  const typicalGap = median(gaps) ?? Math.max(64, imageHeight / 20);
  return centers.map((center, index) => ({
    top: Math.max(0, index > 0 ? (centers[index - 1] + center) / 2 : center - typicalGap / 2),
    bottom: Math.min(
      imageHeight,
      index < centers.length - 1
        ? (center + centers[index + 1]) / 2
        : center + typicalGap / 2,
    ),
  }));
}

function rowHasDate(
  words: readonly FlatOcrWord[],
  top: number,
  bottom: number,
) {
  return words.some((word) => {
    const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
    return centerY >= top && centerY < bottom &&
      /(?:20\d{2}|\(026)[./-]\d{1,2}[./-]\d{1,2}/.test(word.text);
  });
}

function createDateRowCrop(
  source: HTMLCanvasElement,
  rawTop: number,
  rawBottom: number,
) {
  const left = 0;
  const top = Math.max(0, Math.floor(rawTop));
  const width = Math.max(1, Math.min(source.width, Math.ceil(source.width * 0.18)));
  const height = Math.max(1, Math.min(source.height - top, Math.ceil(rawBottom) - top));
  const scale = 2.5;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前设备无法创建日期补充识别画布");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    left,
    top,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const normalized = normalizeGrayscale(imageData.data);
  writeGrayscale(imageData, normalized);
  context.putImageData(imageData, 0, 0);
  return { canvas, left, top, scale };
}

function normalizeNegatedGrayscale(source: Uint8ClampedArray) {
  const grayscale = new Uint8ClampedArray(source.length / 4);
  let minimum = 255;
  let maximum = 0;

  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    const offset = pixel * 4;
    const luminance = Math.round(
      source[offset] * 0.299 +
      source[offset + 1] * 0.587 +
      source[offset + 2] * 0.114,
    );
    const value = 255 - luminance;
    grayscale[pixel] = value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }

  const range = maximum - minimum;
  if (range <= 0) return grayscale;
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    grayscale[pixel] = Math.round(((grayscale[pixel] - minimum) / range) * 255);
  }
  return grayscale;
}

function normalizeGrayscale(source: Uint8ClampedArray) {
  const grayscale = new Uint8ClampedArray(source.length / 4);
  let minimum = 255;
  let maximum = 0;
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    const offset = pixel * 4;
    const value = Math.round(
      source[offset] * 0.299 +
      source[offset + 1] * 0.587 +
      source[offset + 2] * 0.114,
    );
    grayscale[pixel] = value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const range = maximum - minimum;
  if (range <= 0) return grayscale;
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    grayscale[pixel] = Math.round(((grayscale[pixel] - minimum) / range) * 255);
  }
  return grayscale;
}

function writeGrayscale(imageData: ImageData, grayscale: Uint8ClampedArray) {
  for (let pixel = 0; pixel < grayscale.length; pixel += 1) {
    const offset = pixel * 4;
    const value = grayscale[pixel];
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }
}

function sharpenGrayscale(
  source: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (width < 3 || height < 3) return source;
  const output = new Uint8ClampedArray(source);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const sharpened =
        source[index] * 5 -
        source[index - 1] -
        source[index + 1] -
        source[index - width] -
        source[index + width];
      output[index] = Math.max(0, Math.min(255, sharpened));
    }
  }
  return output;
}

async function decodeImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
      element.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function localizeTesseractStatus(status: string) {
  const labels: Record<string, string> = {
    "loading tesseract core": "正在加载本地识别核心",
    "initializing tesseract": "正在初始化本地识别核心",
    "loading language traineddata": "正在加载本地中英文模型",
    "initializing api": "正在初始化中英文识别",
    "recognizing text": "正在识别图片文字",
  };
  return labels[status] ?? "正在本地识别条件单";
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("识别已取消", "AbortError");
  }
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function median(values: readonly number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
