export {};

declare global {
  interface CryptoReviewDesktopState {
    orders: unknown[];
    trades: unknown[];
    openPositions: Array<BinanceApiOpenPosition | OkxApiOpenPosition>;
    trainingResults: unknown[];
    profiles: unknown[];
  }

  interface CryptoReviewDesktopInfo {
    appVersion: string;
    databasePath: string;
    platform: string;
    serverOrigin: string;
    storage: "sqlite";
  }

  interface DesktopUpdateStatus {
    state:
      | "idle"
      | "checking"
      | "available"
      | "downloading"
      | "downloaded"
      | "installing"
      | "current"
      | "error";
    currentVersion: string;
    latestVersion: string | null;
    available: boolean;
    canAutoUpdate: boolean;
    canInstall: boolean;
    checkedAt: number | null;
    releaseUrl: string;
    message: string;
  }

  interface BinanceApiStatus {
    configured: boolean;
    apiKeyHint: string | null;
    lastSyncedAt: number | null;
    updatedAt: number | null;
  }

  interface BinanceApiTradeFill {
    userId: string;
    tradeId: string;
    orderId: string;
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "BOTH" | "LONG" | "SHORT";
    price: number;
    quantity: number;
    quoteQuantity: number;
    commission: number;
    commissionAsset: string;
    realizedPnl: number;
    time: string;
    maker: boolean;
  }

  interface BinanceApiFundingFee {
    userId: string;
    transactionId: string;
    symbol: string;
    incomeType: "FUNDING_FEE";
    amount: number;
    asset: string;
    time: string;
  }

  interface BinanceApiSyncedOrder extends Record<string, unknown> {
    fills?: BinanceApiTradeFill[];
  }

  interface BinanceApiOpenPosition {
    exchangeProvider?: "binance-usdm";
    userId: string;
    symbol: string;
    positionSide: "BOTH" | "LONG" | "SHORT";
    side: "long" | "short";
    quantity: number;
    entryPrice: number;
    breakEvenPrice: number | null;
    markPrice: number;
    unRealizedProfit: number;
    marginAsset: string;
    updateTime: string;
    fundingFeesKnown: boolean;
    fundingFees: BinanceApiFundingFee[];
    fundingFeeNotice?: string;
    syncedAt?: number;
  }

  interface BinanceApiSyncResult {
    accountId: string;
    orders: BinanceApiSyncedOrder[];
    symbols: string[];
    openPositions: BinanceApiOpenPosition[];
    normalOrderCount: number;
    algoOrderCount: number;
    fillCount: number;
    fundingFeeCount: number;
    openPositionCount: number;
    syncedAt: number;
    status: BinanceApiStatus;
  }

  type OkxApiRegion = "global" | "us" | "eea";

  interface OkxApiStatus {
    configured: boolean;
    apiKeyHint: string | null;
    lastSyncedAt: number | null;
    updatedAt: number | null;
  }

  interface OkxApiTradeFill {
    userId: string;
    tradeId: string;
    orderId: string;
    symbol: string;
    side: "BUY" | "SELL";
    positionSide: "BOTH" | "LONG" | "SHORT";
    price: number;
    quantity: number;
    quoteQuantity: number;
    commission: number;
    commissionAsset: string;
    realizedPnl: number;
    time: string;
    maker: boolean;
  }

  interface OkxApiSyncedOrder extends Record<string, unknown> {
    exchangeProvider: "okx-swap";
    fills?: OkxApiTradeFill[];
  }

  interface OkxApiOpenPosition {
    exchangeProvider: "okx-swap";
    userId: string;
    symbol: string;
    positionSide: "BOTH" | "LONG" | "SHORT";
    side: "long" | "short";
    quantity: number;
    entryPrice: number;
    breakEvenPrice: number | null;
    markPrice: number;
    unRealizedProfit: number;
    marginAsset: string;
    updateTime: string;
    syncedAt?: number;
  }

  interface OkxApiWarning {
    code: "unsupported_okx_instrument";
    instrumentId: string;
    message: string;
  }

  interface OkxApiSyncResult {
    accountId: string;
    orders: OkxApiSyncedOrder[];
    symbols: string[];
    openPositions: OkxApiOpenPosition[];
    normalOrderCount: number;
    algoOrderCount: number;
    fillCount: number;
    openPositionCount: number;
    syncedAt: number;
    status: OkxApiStatus;
    warnings?: OkxApiWarning[];
  }

  interface VideoExportBeginResult {
    canceled: boolean;
    exportId?: string;
    filePath?: string;
    mimeType?: string;
  }

  interface VideoExportAppendResult {
    exportId: string;
    bytesWritten: number;
    totalBytes: number;
  }

  interface VideoExportCompleteResult {
    exportId: string;
    filePath: string;
    mimeType: string;
    bytesWritten: number;
  }

  interface CryptoReviewDesktopApi {
    loadState(): Promise<CryptoReviewDesktopState>;
    saveOrders(orders: readonly unknown[]): Promise<void>;
    saveTrades(trades: readonly unknown[]): Promise<void>;
    saveTrainingResults(results: readonly unknown[]): Promise<void>;
    saveProfiles(profiles: readonly unknown[]): Promise<void>;
    getInfo(): Promise<CryptoReviewDesktopInfo>;
    getUpdateStatus(): Promise<DesktopUpdateStatus>;
    checkForUpdates(): Promise<DesktopUpdateStatus>;
    installUpdate(): Promise<DesktopUpdateStatus>;
    openUpdateRelease(): Promise<{ opened: true; url: string }>;
    getBinanceApiStatus(): Promise<BinanceApiStatus>;
    configureBinanceApi(credentials: {
      apiKey: string;
      apiSecret: string;
    }): Promise<BinanceApiStatus>;
    syncBinanceOrders(options: {
      symbols: string[];
      startTime: number;
      endTime: number;
    }): Promise<BinanceApiSyncResult>;
    removeBinanceApi(): Promise<BinanceApiStatus>;
    getOkxApiStatus(): Promise<OkxApiStatus>;
    configureOkxApi(credentials: {
      apiKey: string;
      apiSecret: string;
      passphrase: string;
      region?: OkxApiRegion;
    }): Promise<OkxApiStatus>;
    syncOkxOrders(options: {
      startTime: number;
      endTime: number;
    }): Promise<OkxApiSyncResult>;
    removeOkxApi(): Promise<OkxApiStatus>;
    beginVideoExport(options: {
      suggestedName: string;
      mimeType: string;
    }): Promise<VideoExportBeginResult>;
    appendVideoExport(input: {
      exportId: string;
      chunk: Uint8Array | ArrayBuffer;
    }): Promise<VideoExportAppendResult>;
    completeVideoExport(exportId: string): Promise<VideoExportCompleteResult>;
    cancelVideoExport(exportId: string): Promise<{
      canceled: true;
      exportId: string;
    }>;
    platform?: string;
    version?: string;
  }

  interface Window {
    cryptoReviewDesktop?: CryptoReviewDesktopApi;
  }
}
