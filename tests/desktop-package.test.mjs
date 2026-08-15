import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);

test("桌面入口和打包脚本使用 Electron 43 与 Electron Forge", async () => {
  const [packageSource, forgeSource, mainSource] = await Promise.all([
    readFile(new URL("package.json", projectUrl), "utf8"),
    readFile(new URL("forge.config.cjs", projectUrl), "utf8"),
    readFile(new URL("desktop/main.mjs", projectUrl), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(packageJson.main, "desktop/main.mjs");
  assert.match(packageJson.scripts["desktop:run"], /electron \./);
  assert.match(packageJson.scripts["desktop:package"], /electron-forge package/);
  assert.match(packageJson.scripts["desktop:make:win"], /electron-forge make/);
  assert.equal(packageJson.devDependencies.electron, "43.1.1");
  assert.equal(packageJson.devDependencies["@electron-forge/cli"], "7.11.2");
  assert.match(forgeSource, /asar:\s*true/);
  assert.match(forgeSource, /CryptoReview/);
  assert.match(mainSource, /window\.maximize\(\)/);
  assert.match(mainSource, /width:\s*1600/);
  assert.match(mainSource, /height:\s*1000/);
});

test("桌面打包同时提供 Windows Squirrel 与 macOS ZIP 产物", async () => {
  const packageSource = await readFile(new URL("package.json", projectUrl), "utf8");
  const packageJson = JSON.parse(packageSource);
  const forgeConfig = require("../forge.config.cjs");

  assert.equal(
    packageJson.scripts["desktop:make:mac:arm64"],
    "npm run build && node scripts/make-macos.mjs arm64",
  );
  assert.equal(
    packageJson.scripts["desktop:make:mac:x64"],
    "npm run build && node scripts/make-macos.mjs x64",
  );
  assert.equal(
    packageJson.scripts["desktop:make:mac"],
    "npm run build && node scripts/make-macos.mjs arm64 x64",
  );
  assert.equal(
    packageJson.devDependencies["@electron-forge/maker-zip"],
    "7.11.2",
  );
  assert.equal(
    packageJson.devDependencies["@electron-forge/maker-squirrel"],
    "7.11.2",
  );
  assert.equal(
    forgeConfig.packagerConfig.appBundleId,
    "com.cryptoreview.desktop",
  );
  assert.equal(
    forgeConfig.packagerConfig.appCategoryType,
    "public.app-category.finance",
  );
  assert.deepEqual(forgeConfig.makers, [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "CryptoReview",
        authors: "xin",
        description: "Binance 与 OKX U 本位合约本地交易复盘桌面应用",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ]);
});

test("本地架构文档与用户数据文件不会进入 Git 或桌面安装包", async () => {
  const gitignore = await readFile(new URL(".gitignore", projectUrl), "utf8");
  const forgeConfig = require("../forge.config.cjs");
  const isPackagerIgnored = (filePath) =>
    forgeConfig.packagerConfig.ignore.some((pattern) => pattern.test(filePath));

  assert.match(gitignore, /^\/AI_README\.md$/m);
  for (const filePath of [
    "/AI_README.md",
    "/.env",
    "/.env.local",
    "/cryptoreview.db",
    "/orders.csv",
    "/debug.log",
    "/trade-export.mp4",
  ]) {
    assert.equal(isPackagerIgnored(filePath), true, `${filePath} 必须排除在安装包外`);
  }
});

test("Windows Squirrel 首次安装、升级和卸载会维护应用快捷方式", async () => {
  const { getSquirrelStartupPlan } = await import("../desktop/squirrel-startup.mjs");
  const options = {
    platform: "win32",
    execPath: "C:\\Users\\xin\\AppData\\Local\\CryptoReview\\app-0.2.0\\CryptoReview.exe",
  };

  assert.deepEqual(
    getSquirrelStartupPlan({ ...options, argv: ["electron", "--squirrel-install"] }),
    {
      command: "C:\\Users\\xin\\AppData\\Local\\CryptoReview\\Update.exe",
      args: ["--createShortcut=CryptoReview.exe"],
    },
  );
  assert.deepEqual(
    getSquirrelStartupPlan({ ...options, argv: ["electron", "--squirrel-uninstall"] }),
    {
      command: "C:\\Users\\xin\\AppData\\Local\\CryptoReview\\Update.exe",
      args: ["--removeShortcut=CryptoReview.exe"],
    },
  );
});

test("Windows 打包 macOS ZIP 时使用可保留 .app 符号链接的 bsdtar", async () => {
  const macMaker = await import("../scripts/make-macos.mjs");
  const plan = macMaker.createArchivePlan({
    platform: "win32",
    appPath: "C:\\build\\CryptoReview.app",
    packageDirectory: "C:\\build",
    zipPath: "C:\\out\\CryptoReview.zip",
  });

  assert.equal(plan.command, "tar.exe");
  assert.deepEqual(plan.args.slice(0, 4), [
    "-a",
    "-c",
    "-f",
    "C:\\out\\CryptoReview.zip",
  ]);
  assert.deepEqual(plan.args.slice(4), [
    "-C",
    "C:\\build",
    "CryptoReview.app",
  ]);
});

test("Windows 生成的 macOS ZIP 会把 Mach-O 主程序恢复为 Unix 可执行权限", async () => {
  const macMaker = await import("../scripts/make-macos.mjs");
  const entryName = "CryptoReview.app/Contents/MacOS/CryptoReview";
  const machOHeader = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

  assert.equal(
    macMaker.getMacBundleUnixMode({
      entryType: "file",
      entryName,
      header: machOHeader,
    }),
    0o100755,
  );
  assert.equal(
    macMaker.getMacBundleUnixMode({
      entryType: "file",
      entryName: "CryptoReview.app/Contents/Resources/app.asar",
      header: Buffer.from("asar"),
    }),
    0o100644,
  );
  assert.equal(
    macMaker.getMacBundleUnixMode({
      entryType: "symlink",
      entryName:
        "CryptoReview.app/Contents/Frameworks/Electron Framework.framework/Resources",
    }),
    0o120777,
  );

  const encodedName = Buffer.from(entryName);
  const centralDirectorySize = 46 + encodedName.length;
  const zip = Buffer.alloc(centralDirectorySize + 22);
  zip.writeUInt32LE(0x02014b50, 0);
  zip.writeUInt16LE(20, 4);
  zip.writeUInt16LE(encodedName.length, 28);
  encodedName.copy(zip, 46);
  zip.writeUInt32LE(0x06054b50, centralDirectorySize);
  zip.writeUInt16LE(1, centralDirectorySize + 10);
  zip.writeUInt32LE(centralDirectorySize, centralDirectorySize + 12);
  zip.writeUInt32LE(0, centralDirectorySize + 16);

  assert.equal(
    macMaker.patchZipCentralDirectoryUnixModes(
      zip,
      new Map([[entryName, 0o100755]]),
    ),
    1,
  );
  assert.equal(zip.readUInt16LE(4) >> 8, 3);
  assert.equal(zip.readUInt32LE(38) >>> 16, 0o100755);
});

test("preload 只暴露固定的桌面存储能力，不开放通用 IPC", async () => {
  const preload = await readFile(new URL("desktop/preload.cjs", projectUrl), "utf8");

  assert.match(preload, /contextBridge\.exposeInMainWorld\("cryptoReviewDesktop"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:load-state"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:save-orders"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:save-trades"/);
  assert.match(preload, /ipcRenderer\.invoke\(\s*"desktop:save-training-results"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:get-info"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:update-status"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:update-check"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:update-install"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:update-open-release"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:binance-api-status"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:binance-api-configure"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:binance-api-sync-orders"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:binance-api-remove"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:okx-api-status"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:okx-api-configure"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:okx-api-sync-orders"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:okx-api-remove"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:video-export-begin"/);
  assert.match(preload, /ipcRenderer\.invoke\("desktop:video-export-append"/);
  assert.match(preload, /"desktop:video-export-complete"/);
  assert.match(preload, /"desktop:video-export-cancel"/);
  assert.match(preload, /requireVideoChunk/);
  assert.doesNotMatch(
    preload,
    /getBinanceApiSecret|readBinanceCredentials|getOkxApiSecret|getOkxPassphrase|readOkxCredentials/,
  );
  assert.doesNotMatch(preload, /ipcRenderer\.send/);
  assert.doesNotMatch(preload, /send:\s*ipcRenderer/);
});

test("桌面构建会准备本地 OCR worker、核心与中英文模型", async () => {
  const [packageSource, assetScript] = await Promise.all([
    readFile(new URL("package.json", projectUrl), "utf8"),
    readFile(new URL("scripts/prepare-ocr-assets.mjs", projectUrl), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts.prebuild, /prepare:ocr/);
  assert.match(packageJson.scripts.predev, /prepare:ocr/);
  assert.equal(packageJson.dependencies["tesseract.js"], "^7.0.0");
  assert.match(assetScript, /worker\.min\.js/);
  assert.match(assetScript, /tesseract-core-relaxedsimd-lstm\.wasm\.js/);
  assert.match(assetScript, /chi_sim\.traineddata\.gz/);
  assert.match(assetScript, /eng\.traineddata\.gz/);
});
