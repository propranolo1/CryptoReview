const { contextBridge, ipcRenderer } = require("electron");

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}必须是数组`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}必须是非空字符串`);
  }
  return value.trim();
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label}必须是有效毫秒时间戳`);
  }
  return value;
}

function requireVideoChunk(value) {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
    throw new TypeError("视频分块必须是 Uint8Array 或 ArrayBuffer");
  }
  return value;
}

contextBridge.exposeInMainWorld("cryptoReviewDesktop", Object.freeze({
  loadState: () => ipcRenderer.invoke("desktop:load-state"),
  saveOrders: (orders) =>
    ipcRenderer.invoke("desktop:save-orders", requireArray(orders, "订单记录")),
  saveTrades: (trades) =>
    ipcRenderer.invoke("desktop:save-trades", requireArray(trades, "复盘记录")),
  saveReplaySnapshot: (snapshot) => {
    const value = requireRecord(snapshot, "复盘快照");
    return ipcRenderer.invoke("desktop:save-replay-snapshot", {
      orders: requireArray(value.orders, "订单记录"),
      trades: requireArray(value.trades, "复盘记录"),
    });
  },
  saveTrainingResults: (results) =>
    ipcRenderer.invoke(
      "desktop:save-training-results",
      requireArray(results, "训练记录"),
    ),
  saveProfiles: (profiles) =>
    ipcRenderer.invoke(
      "desktop:save-profiles",
      requireArray(profiles, "复盘用户"),
    ),
  deleteProfile: (profileId) =>
    ipcRenderer.invoke(
      "desktop:delete-profile",
      requireString(profileId, "复盘用户 ID"),
    ),
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:update-status"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:update-check"),
  installUpdate: () => ipcRenderer.invoke("desktop:update-install"),
  openUpdateRelease: () => ipcRenderer.invoke("desktop:update-open-release"),
  getBinanceApiStatus: () => ipcRenderer.invoke("desktop:binance-api-status"),
  configureBinanceApi: (credentials) => {
    const value = requireRecord(credentials, "Binance API 凭证");
    return ipcRenderer.invoke("desktop:binance-api-configure", {
      apiKey: requireString(value.apiKey, "API Key"),
      apiSecret: requireString(value.apiSecret, "Secret Key"),
    });
  },
  syncBinanceOrders: (options) => {
    const value = requireRecord(options, "Binance 同步参数");
    return ipcRenderer.invoke("desktop:binance-api-sync-orders", {
      symbols: requireArray(value.symbols, "交易对").map((symbol) =>
        requireString(symbol, "交易对"),
      ),
      startTime: requireTimestamp(value.startTime, "同步开始时间"),
      endTime: requireTimestamp(value.endTime, "同步结束时间"),
      incremental: Boolean(value.incremental),
    });
  },
  removeBinanceApi: () => ipcRenderer.invoke("desktop:binance-api-remove"),
  getOkxApiStatus: () => ipcRenderer.invoke("desktop:okx-api-status"),
  configureOkxApi: (credentials) => {
    const value = requireRecord(credentials, "OKX API 凭证");
    return ipcRenderer.invoke("desktop:okx-api-configure", {
      apiKey: requireString(value.apiKey, "API Key"),
      apiSecret: requireString(value.apiSecret, "Secret Key"),
      passphrase: requireString(value.passphrase, "Passphrase"),
      region: requireString(value.region ?? "global", "Region"),
    });
  },
  syncOkxOrders: (options) => {
    const value = requireRecord(options, "OKX 同步参数");
    return ipcRenderer.invoke("desktop:okx-api-sync-orders", {
      startTime: requireTimestamp(value.startTime, "同步开始时间"),
      endTime: requireTimestamp(value.endTime, "同步结束时间"),
      incremental: Boolean(value.incremental),
    });
  },
  onExchangeSyncProgress: (listener) => {
    if (typeof listener !== "function") throw new TypeError("同步进度监听器必须是函数");
    const wrapped = (_event, progress) => listener(progress);
    ipcRenderer.on("desktop:exchange-sync-progress", wrapped);
    return () => ipcRenderer.removeListener("desktop:exchange-sync-progress", wrapped);
  },
  removeOkxApi: () => ipcRenderer.invoke("desktop:okx-api-remove"),
  beginVideoExport: (options) => {
    const value = requireRecord(options, "视频导出参数");
    return ipcRenderer.invoke("desktop:video-export-begin", {
      suggestedName: requireString(value.suggestedName, "视频文件名"),
      mimeType: requireString(value.mimeType, "视频格式"),
    });
  },
  appendVideoExport: (input) => {
    const value = requireRecord(input, "视频分块参数");
    return ipcRenderer.invoke("desktop:video-export-append", {
      exportId: requireString(value.exportId, "视频导出任务编号"),
      chunk: requireVideoChunk(value.chunk),
    });
  },
  completeVideoExport: (exportId) =>
    ipcRenderer.invoke(
      "desktop:video-export-complete",
      requireString(exportId, "视频导出任务编号"),
    ),
  cancelVideoExport: (exportId) =>
    ipcRenderer.invoke(
      "desktop:video-export-cancel",
      requireString(exportId, "视频导出任务编号"),
    ),
}));
