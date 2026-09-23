import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const script = fileURLToPath(new URL("./squirrel-executable-delta.ps1", import.meta.url));
const squirrel = path.join(path.dirname(require.resolve("electron-winstaller/package.json")), "vendor", "Squirrel.exe");

export async function repairSquirrelExecutable({ directory, baseline, full, delta }) {
  const work = await mkdtemp(path.join(directory, ".exe-delta-"));
  try {
    const { stdout } = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Baseline", path.join(directory, baseline ?? "missing-baseline.nupkg"),
      "-Full", path.join(directory, full), "-Delta", path.join(directory, delta),
      "-Squirrel", squirrel, "-Work", work,
    ], { windowsHide: true, timeout: 10 * 60 * 1000 });
    return JSON.parse(stdout.replace(/^\uFEFF/, "")).repaired;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
