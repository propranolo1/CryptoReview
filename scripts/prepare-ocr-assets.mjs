import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(projectRoot, "public", "ocr");

const assets = [
  ["node_modules/tesseract.js/dist/worker.min.js", "worker.min.js"],
  [
    "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
    "core/tesseract-core-lstm.wasm.js",
  ],
  [
    "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
    "core/tesseract-core-simd-lstm.wasm.js",
  ],
  [
    "node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
    "core/tesseract-core-relaxedsimd-lstm.wasm.js",
  ],
  [
    "node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz",
    "lang/chi_sim.traineddata.gz",
  ],
  [
    "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    "lang/eng.traineddata.gz",
  ],
];

await Promise.all(
  assets.map(async ([source, target]) => {
    const destination = resolve(publicRoot, target);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(projectRoot, source), destination);
  }),
);

console.log(`OCR 离线资源已准备：${publicRoot}`);
