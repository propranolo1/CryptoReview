import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidIconRecord, normalizeIconToken } from "../lib/asset-icons.mjs";

/** 缓存只有公开币种图片；路径由币种编码生成，不接收页面传入的文件路径。 */
export function createDiskAssetIconCache(directory, { maxEntries = 256 } = {}) {
  const root = path.resolve(directory);
  let writeTask = Promise.resolve();
  const fileFor = (token) => {
    if (!token || normalizeIconToken(token) !== token) throw new Error("图标缓存币种无效");
    return path.join(root, `${Buffer.from(token, "utf8").toString("hex")}.json`);
  };
  return {
    async readCache(token) {
      try {
        const file = fileFor(token);
        if ((await stat(file)).size > 400_000) return null;
        const record = JSON.parse(await readFile(file, "utf8"));
        return isValidIconRecord(record, token) ? record : null;
      } catch { return null; }
    },
    writeCache(record) {
      if (!isValidIconRecord(record, record?.token)) return Promise.reject(new Error("图标缓存内容无效"));
      const task = writeTask.then(async () => {
        await mkdir(root, { recursive: true });
        const file = fileFor(record.token), temporary = `${file}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(record));
          await rename(temporary, file);
        } finally { await unlink(temporary).catch(() => {}); }
        const files = (await readdir(root)).filter((name) => /^[a-f0-9]+\.json$/.test(name));
        if (files.length <= maxEntries) return;
        const entries = await Promise.all(files.map(async (name) => ({ name, time: (await stat(path.join(root, name))).mtimeMs })));
        entries.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
        await Promise.all(entries.slice(0, entries.length - maxEntries).map(({ name }) => unlink(path.join(root, name))));
      });
      writeTask = task.catch(() => {});
      return task;
    },
  };
}
