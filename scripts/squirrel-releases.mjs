import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareVersions } from "../desktop/update-service.mjs";
import { repairSquirrelExecutable } from "./squirrel-executable-delta.mjs";

const RELEASE_BASE = "https://github.com/propranolo1/CryptoReview/releases/download";

function parseEntries(source, version) {
  const seen = new Set();
  return source.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map((line) => {
    const match = /^([a-f\d]{40}) (\S+) ([1-9]\d*)$/i.exec(line);
    if (!match) throw new Error("Squirrel 发布清单格式错误");
    const [, sha, location, size] = match;
    const filename = location.slice(location.lastIndexOf("/") + 1);
    const packageMatch = /^CryptoReview-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/.exec(filename);
    if (!packageMatch) throw new Error("Squirrel 发布清单包含未知安装包");
    const [, packageVersion, kind] = packageMatch;
    const url = `${RELEASE_BASE}/v${packageVersion}/${filename}`;
    if (location !== filename && location !== url) {
      throw new Error("Squirrel 安装包必须来自本项目的固定 GitHub Release");
    }
    if (compareVersions(packageVersion, version) > 0 || seen.has(filename)) {
      throw new Error("Squirrel 发布清单包含未来版本或重复安装包");
    }
    seen.add(filename);
    return { sha, size: Number(size), filename, version: packageVersion, kind, url };
  });
}

async function packageDigest(directory, entry) {
  const file = path.join(directory, entry.filename);
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha: hash.digest("hex"), size: (await stat(file)).size };
}

async function verifyPackage(directory, entry) {
  const actual = await packageDigest(directory, entry);
  if (actual.sha !== entry.sha.toLowerCase() || actual.size !== entry.size) {
    throw new Error(`Squirrel 安装包校验失败：${entry.filename}`);
  }
}

export async function prepareSquirrelReleases(results, { repairExecutable = repairSquirrelExecutable } = {}) {
  for (const result of results) {
    if (result.platform !== "win32") continue;
    const manifestPath = result.artifacts.find((file) => path.basename(file) === "RELEASES");
    if (!manifestPath) throw new Error("Windows 安装包缺少 RELEASES 清单");
    const version = result.packageJSON.version;
    const entries = parseEntries(await readFile(manifestPath, "utf8"), version);
    const full = entries.find((entry) => entry.version === version && entry.kind === "full");
    const delta = entries.find((entry) => entry.version === version && entry.kind === "delta");
    if (!full) throw new Error("当前版本缺少完整包，不能发布");
    if (!delta) throw new Error("当前版本缺少差分包，请检查上一版 Release 是否可下载且版本更低");
    const directory = path.dirname(manifestPath);
    const baseline = entries.filter((entry) => entry.kind === "full" && compareVersions(entry.version, version) < 0)
      .sort((left, right) => compareVersions(right.version, left.version))[0];
    await Promise.all([full, delta, ...(baseline ? [baseline] : [])].map((entry) => verifyPackage(directory, entry)));
    if (await repairExecutable({ directory, baseline: baseline?.filename, full: full.filename, delta: delta.filename })) {
      Object.assign(delta, await packageDigest(directory, delta));
    }

    // update.electronjs.org 只把首个包名改写为下载地址。将当前完整包置于首行，
    // 其余差分包使用固定版本绝对地址，同时保留旧差分链，供跳过版本时连续应用。
    const deltas = entries.filter((entry) => entry.kind === "delta")
      .sort((left, right) => compareVersions(left.version, right.version));
    const lines = [
      `${full.sha} ${full.filename} ${full.size}`,
      ...deltas.map((entry) => `${entry.sha} ${entry.url} ${entry.size}`),
    ];
    await writeFile(manifestPath, `${lines.join("\n")}\n`, "utf8");
  }
  return results;
}
