import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startLocalServer } from "./local-server.mjs";
import { handleSquirrelStartup } from "./squirrel-startup.mjs";
import { createUpdateService } from "./update-service.mjs";
import { createVideoExportService } from "./video-export-service.mjs";

const PRELOAD_PATH = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const IPC_CHANNELS = [
  "desktop:load-state",
  "desktop:save-orders",
  "desktop:save-trades",
  "desktop:save-training-results",
  "desktop:save-profiles",
  "desktop:delete-profile",
  "desktop:get-info",
  "desktop:update-status",
  "desktop:update-check",
  "desktop:update-install",
  "desktop:update-open-release",
  "desktop:binance-api-status",
  "desktop:binance-api-configure",
  "desktop:binance-api-sync-orders",
  "desktop:binance-api-remove",
  "desktop:okx-api-status",
  "desktop:okx-api-configure",
  "desktop:okx-api-sync-orders",
  "desktop:okx-api-remove",
  "desktop:video-export-begin",
  "desktop:video-export-append",
  "desktop:video-export-complete",
  "desktop:video-export-cancel",
];

export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});

export function isAllowedNavigation(targetUrl, localOrigin) {
  try {
    return new URL(targetUrl).origin === localOrigin;
  } catch {
    return false;
  }
}

function isExternalHttpUrl(targetUrl, localOrigin) {
  try {
    const url = new URL(targetUrl);
    return (
      url.origin !== localOrigin &&
      (url.protocol === "https:" || url.protocol === "http:")
    );
  } catch {
    return false;
  }
}

export function registerDesktopIpc({
  ipcMain,
  repository,
  binanceApiService,
  okxApiService,
  videoExportService,
  updateService,
  shell,
  app,
  databasePath,
  serverOrigin,
}) {
  for (const channel of IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle("desktop:load-state", () => repository.loadState());
  ipcMain.handle("desktop:save-orders", (_event, orders) =>
    repository.saveOrders(orders),
  );
  ipcMain.handle("desktop:save-trades", (_event, trades) =>
    repository.saveTrades(trades),
  );
  ipcMain.handle("desktop:save-training-results", (_event, results) =>
    repository.saveTrainingResults(results),
  );
  ipcMain.handle("desktop:save-profiles", (_event, profiles) =>
    repository.saveProfiles(profiles),
  );
  ipcMain.handle("desktop:get-info", () => ({
    appVersion: app.getVersion(),
    databasePath,
    platform: process.platform,
    serverOrigin,
    storage: "sqlite",
    version: app.getVersion(),
  }));
  const trustedHandler = (handler) => (event, ...args) => {
    if (!isAllowedNavigation(event?.senderFrame?.url ?? "", serverOrigin)) {
      throw new Error("已拒绝不受信任页面调用桌面敏感能力");
    }
    return handler(...args);
  };
  ipcMain.handle(
    "desktop:delete-profile",
    trustedHandler((profileId) => repository.deleteProfile(profileId)),
  );
  ipcMain.handle(
    "desktop:update-status",
    trustedHandler(() => updateService.getStatus()),
  );
  ipcMain.handle(
    "desktop:update-check",
    trustedHandler(() => updateService.check({ manual: true })),
  );
  ipcMain.handle(
    "desktop:update-install",
    trustedHandler(() => updateService.install()),
  );
  ipcMain.handle(
    "desktop:update-open-release",
    trustedHandler(async () => {
      const url = updateService.getStatus().releaseUrl;
      await shell.openExternal(url);
      return { opened: true, url };
    }),
  );
  ipcMain.handle(
    "desktop:binance-api-status",
    trustedHandler(() => binanceApiService.getStatus()),
  );
  ipcMain.handle(
    "desktop:binance-api-configure",
    trustedHandler((credentials) => binanceApiService.configure(credentials)),
  );
  ipcMain.handle(
    "desktop:binance-api-sync-orders",
    trustedHandler((options) => binanceApiService.syncOrders(options)),
  );
  ipcMain.handle(
    "desktop:binance-api-remove",
    trustedHandler(() => binanceApiService.remove()),
  );
  ipcMain.handle(
    "desktop:okx-api-status",
    trustedHandler(() => okxApiService.getStatus()),
  );
  ipcMain.handle(
    "desktop:okx-api-configure",
    trustedHandler((credentials) => okxApiService.configure(credentials)),
  );
  ipcMain.handle(
    "desktop:okx-api-sync-orders",
    trustedHandler((options) => okxApiService.syncOrders(options)),
  );
  ipcMain.handle(
    "desktop:okx-api-remove",
    trustedHandler(() => okxApiService.remove()),
  );
  ipcMain.handle(
    "desktop:video-export-begin",
    trustedHandler((options) => videoExportService.begin(options)),
  );
  ipcMain.handle(
    "desktop:video-export-append",
    trustedHandler((input) => videoExportService.append(input)),
  );
  ipcMain.handle(
    "desktop:video-export-complete",
    trustedHandler((exportId) => videoExportService.complete(exportId)),
  );
  ipcMain.handle(
    "desktop:video-export-cancel",
    trustedHandler((exportId) => videoExportService.cancel(exportId)),
  );

  return () => {
    for (const channel of IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  };
}

function secureWindowContents({ webContents, localOrigin, shell }) {
  webContents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedNavigation(targetUrl, localOrigin)) {
      return;
    }

    event.preventDefault();
    if (isExternalHttpUrl(targetUrl, localOrigin)) {
      void shell.openExternal(targetUrl);
    }
  });

  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url, localOrigin)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

function createMainWindow({ BrowserWindow, shell, localOrigin }) {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#07111f",
    autoHideMenuBar: true,
    title: "CryptoReview",
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: PRELOAD_PATH,
    },
  });

  secureWindowContents({
    webContents: window.webContents,
    localOrigin,
    shell,
  });
  window.once("ready-to-show", () => {
    window.maximize();
    window.show();
  });
  void window.loadURL(localOrigin);
  return window;
}

export async function bootstrapDesktopApp(electron) {
  const {
    app,
    autoUpdater,
    BrowserWindow,
    dialog,
    ipcMain,
    net,
    safeStorage,
    shell,
  } = electron;
  await app.whenReady();

  const databaseDirectory = path.join(app.getPath("userData"), "data");
  const databasePath = path.join(databaseDirectory, "cryptoreview.db");
  await mkdir(databaseDirectory, { recursive: true });

  const { createDesktopRepository } = await import("./database.mjs");
  const repository = await createDesktopRepository(databasePath);
  const [
    { createBinanceCredentialVault },
    { createBinanceUsdmClient },
    { createBinanceApiService },
    { createOkxCredentialVault },
    { createOkxClient },
    { createOkxApiService },
  ] = await Promise.all([
    import("./binance-credential-vault.mjs"),
    import("./binance-usdm-client.mjs"),
    import("./binance-api-service.mjs"),
    import("./okx-credential-vault.mjs"),
    import("./okx-client.mjs"),
    import("./okx-api-service.mjs"),
  ]);
  const credentialVault = createBinanceCredentialVault({ repository, safeStorage });
  const binanceClient = createBinanceUsdmClient({
    fetchImpl: (input, init) => net.fetch(input, init),
  });
  const binanceApiService = createBinanceApiService({
    repository,
    vault: credentialVault,
    client: binanceClient,
  });
  const okxCredentialVault = createOkxCredentialVault({ repository, safeStorage });
  const okxClient = createOkxClient({
    fetchImpl: (input, init) => net.fetch(input, init),
  });
  const okxApiService = createOkxApiService({
    repository,
    vault: okxCredentialVault,
    client: okxClient,
  });
  const videoExportService = createVideoExportService({ dialog });
  const updateService = createUpdateService({
    app,
    autoUpdater,
    fetchImpl: (input, init) => net.fetch(input, init),
  });
  let localServer;
  try {
    localServer = await startLocalServer({ projectRoot: app.getAppPath() });
  } catch (error) {
    await Promise.resolve(repository.close());
    throw error;
  }
  const unregisterIpc = registerDesktopIpc({
    ipcMain,
    repository,
    binanceApiService,
    okxApiService,
    videoExportService,
    updateService,
    shell,
    app,
    databasePath,
    serverOrigin: localServer.origin,
  });

  let mainWindow = createMainWindow({
    BrowserWindow,
    shell,
    localOrigin: localServer.origin,
  });
  updateService.start();
  let cleanupPromise = null;

  const cleanup = () => {
    cleanupPromise ??= Promise.allSettled([
      Promise.resolve().then(() => unregisterIpc()),
      videoExportService.dispose(),
      Promise.resolve().then(() => updateService.dispose()),
      Promise.resolve().then(() => repository.close()),
      localServer.close(),
    ]);
    return cleanupPromise;
  };

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow({
        BrowserWindow,
        shell,
        localOrigin: localServer.origin,
      });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", (event) => {
    if (cleanupPromise) {
      return;
    }

    event.preventDefault();
    void cleanup().then(() => app.quit());
  });

  app.on("before-quit-for-update", () => {
    void cleanup();
  });

  return {
    databasePath,
    localOrigin: localServer.origin,
    mainWindow,
    close: cleanup,
  };
}

if (process.versions.electron) {
  void import("electron")
    .then((electron) => {
      if (handleSquirrelStartup({ app: electron.app })) {
        return undefined;
      }
      return bootstrapDesktopApp(electron);
    })
    .catch((error) => {
      console.error("CryptoReview 桌面版启动失败", error);
      process.exitCode = 1;
    });
}
