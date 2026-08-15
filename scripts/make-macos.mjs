import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectDirectory = path.resolve(path.dirname(scriptPath), "..");
const supportedArchitectures = new Set(["arm64", "x64"]);
const machOMagicNumbers = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

export function createArchivePlan({
  platform,
  appPath,
  packageDirectory,
  zipPath,
}) {
  const appName =
    platform === "win32"
      ? path.win32.basename(appPath)
      : path.posix.basename(appPath);

  if (platform === "win32") {
    // Windows 的 .NET ZipFile 会沿着 macOS 框架符号链接读取，导致拒绝访问；
    // bsdtar 会把链接本身写入 ZIP，解压到 macOS 后结构仍然正确。
    return {
      command: "tar.exe",
      args: ["-a", "-c", "-f", zipPath, "-C", packageDirectory, appName],
    };
  }

  if (platform === "darwin") {
    return {
      command: "ditto",
      args: ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
    };
  }

  return {
    command: "zip",
    args: ["-r", "-y", zipPath, appName],
    cwd: packageDirectory,
  };
}

export function getMacBundleUnixMode({
  entryType,
  entryName,
  header = Buffer.alloc(0),
}) {
  if (entryType === "directory") {
    return 0o040755;
  }

  if (entryType === "symlink") {
    return 0o120777;
  }

  const normalizedName = entryName.replaceAll("\\", "/");
  const magicNumber =
    header.length >= 4 ? header.readUInt32BE(0) : Number.NaN;
  const hasShebang =
    header.length >= 2 && header[0] === 0x23 && header[1] === 0x21;
  const isExecutable =
    normalizedName.includes("/Contents/MacOS/") ||
    machOMagicNumbers.has(magicNumber) ||
    hasShebang;

  return isExecutable ? 0o100755 : 0o100644;
}

function findEndOfCentralDirectory(zipBuffer) {
  const minimumOffset = Math.max(0, zipBuffer.length - 65_557);

  for (let offset = zipBuffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error("macOS ZIP 缺少中央目录结束记录");
}

export function patchZipCentralDirectoryUnixModes(zipBuffer, modeByEntryName) {
  const endOffset = findEndOfCentralDirectory(zipBuffer);
  const entryCount = zipBuffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = zipBuffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(endOffset + 16);

  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("macOS ZIP 使用了当前打包器不支持的 ZIP64 中央目录");
  }

  let cursor = centralDirectoryOffset;
  let patchedCount = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`macOS ZIP 第 ${index + 1} 个中央目录记录无效`);
    }

    const nameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const entryName = zipBuffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8")
      .replaceAll("\\", "/");
    const unixMode = modeByEntryName.get(entryName);

    if (unixMode !== undefined) {
      const madeByVersion = zipBuffer.readUInt16LE(cursor + 4) & 0x00ff;
      const existingAttributes = zipBuffer.readUInt32LE(cursor + 38) & 0xffff;
      const unixAttributes =
        (((unixMode & 0xffff) << 16) | existingAttributes) >>> 0;

      zipBuffer.writeUInt16LE(madeByVersion | (3 << 8), cursor + 4);
      zipBuffer.writeUInt32LE(unixAttributes, cursor + 38);
      patchedCount += 1;
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (cursor > centralDirectoryOffset + centralDirectorySize) {
    throw new Error("macOS ZIP 中央目录长度无效");
  }

  return patchedCount;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectDirectory,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 128 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = options.capture
      ? `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
      : "";
    throw new Error(
      `${command} 执行失败（退出码 ${result.status}）${detail ? `：\n${detail}` : ""}`,
    );
  }

  return result;
}

async function readFileHeader(filePath) {
  const handle = await open(filePath, "r");

  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function collectMacBundleUnixModes(
  currentPath,
  entryName,
  modeByEntryName,
) {
  const stats = await lstat(currentPath);

  if (stats.isSymbolicLink()) {
    modeByEntryName.set(
      entryName,
      getMacBundleUnixMode({ entryType: "symlink", entryName }),
    );
    return;
  }

  if (stats.isDirectory()) {
    const directoryEntryName = `${entryName.replace(/\/$/, "")}/`;
    modeByEntryName.set(
      directoryEntryName,
      getMacBundleUnixMode({
        entryType: "directory",
        entryName: directoryEntryName,
      }),
    );

    const directory = await opendir(currentPath);
    for await (const child of directory) {
      await collectMacBundleUnixModes(
        path.join(currentPath, child.name),
        path.posix.join(entryName, child.name),
        modeByEntryName,
      );
    }
    return;
  }

  if (stats.isFile()) {
    const header = await readFileHeader(currentPath);
    modeByEntryName.set(
      entryName,
      getMacBundleUnixMode({ entryType: "file", entryName, header }),
    );
  }
}

async function patchWindowsArchivePermissions(zipPath, appPath, productName) {
  const modeByEntryName = new Map();
  await collectMacBundleUnixModes(
    appPath,
    `${productName}.app`,
    modeByEntryName,
  );

  const zipBuffer = await readFile(zipPath);
  const patchedCount = patchZipCentralDirectoryUnixModes(
    zipBuffer,
    modeByEntryName,
  );

  if (patchedCount !== modeByEntryName.size) {
    throw new Error(
      `macOS ZIP 权限记录不完整：应写入 ${modeByEntryName.size} 项，实际 ${patchedCount} 项`,
    );
  }

  await writeFile(zipPath, zipBuffer);
}

function verifyWindowsArchive(zipPath, productName) {
  const listing = runCommand("tar.exe", ["-tvf", zipPath], {
    capture: true,
  }).stdout;
  const normalized = listing.replaceAll("\\", "/");
  const asarPath = `${productName}.app/Contents/Resources/app.asar`;
  const frameworkLink =
    `${productName}.app/Contents/Frameworks/` +
    "Electron Framework.framework/Resources -> Versions/Current/Resources";
  const frameworkLine = normalized
    .split(/\r?\n/)
    .find((line) => line.includes(frameworkLink));
  const executablePath = `${productName}.app/Contents/MacOS/${productName}`;
  const executableLine = normalized
    .split(/\r?\n/)
    .find((line) => line.trimEnd().endsWith(executablePath));

  if (!normalized.includes(asarPath)) {
    throw new Error(`macOS ZIP 缺少 ${asarPath}`);
  }

  if (!frameworkLine || !frameworkLine.trimStart().startsWith("l")) {
    throw new Error("macOS ZIP 未保留 Electron Framework 的 Resources 符号链接");
  }

  if (!executableLine || !executableLine.trimStart().startsWith("-rwxr-xr-x")) {
    throw new Error("macOS ZIP 主程序缺少 Unix 可执行权限");
  }
}

async function packageArchitecture(architecture, packageJson) {
  const forgeCli = path.join(
    projectDirectory,
    "node_modules",
    "@electron-forge",
    "cli",
    "dist",
    "electron-forge.js",
  );
  runCommand(process.execPath, [
    forgeCli,
    "package",
    "--platform=darwin",
    `--arch=${architecture}`,
  ]);

  const packageDirectory = path.join(
    projectDirectory,
    "out",
    `${packageJson.productName}-darwin-${architecture}`,
  );
  const appPath = path.join(
    packageDirectory,
    `${packageJson.productName}.app`,
  );
  const zipDirectory = path.join(
    projectDirectory,
    "out",
    "make",
    "zip",
    "darwin",
    architecture,
  );
  const zipPath = path.join(
    zipDirectory,
    `${packageJson.productName}-darwin-${architecture}-${packageJson.version}.zip`,
  );

  await mkdir(zipDirectory, { recursive: true });
  await rm(zipPath, { force: true });

  const archivePlan = createArchivePlan({
    platform: process.platform,
    appPath,
    packageDirectory,
    zipPath,
  });
  runCommand(archivePlan.command, archivePlan.args, {
    cwd: archivePlan.cwd,
  });

  if (process.platform === "win32") {
    await patchWindowsArchivePermissions(
      zipPath,
      appPath,
      packageJson.productName,
    );
    verifyWindowsArchive(zipPath, packageJson.productName);
  }

  console.log(`macOS ${architecture} ZIP 已生成：${zipPath}`);
}

async function main() {
  const requestedArchitectures =
    process.argv.length > 2 ? process.argv.slice(2) : ["arm64", "x64"];
  const invalidArchitecture = requestedArchitectures.find(
    (architecture) => !supportedArchitectures.has(architecture),
  );

  if (invalidArchitecture) {
    throw new Error(`不支持的 macOS 架构：${invalidArchitecture}`);
  }

  const packageJson = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  );

  for (const architecture of requestedArchitectures) {
    await packageArchitecture(architecture, packageJson);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
