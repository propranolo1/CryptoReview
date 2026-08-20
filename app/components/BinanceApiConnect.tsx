"use client";

import { KeyRound, Link2, RefreshCw, ShieldCheck, Unplug, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./BinanceApiConnect.module.css";

type Props = {
  defaultSymbols: readonly string[];
  onSync: (result: BinanceApiSyncResult) => void | Promise<void>;
  onOkxSync: (result: OkxApiSyncResult) => void | Promise<void>;
  disabled?: boolean;
};

type ExchangeTab = "binance" | "okx";
type OkxRegion = "global" | "us" | "eea";
type BusyState =
  | "status"
  | "binance-configure"
  | "binance-sync"
  | "binance-remove"
  | "okx-configure"
  | "okx-sync"
  | "okx-remove"
  | "quick-sync"
  | null;
type Feedback = {
  kind: "success" | "error";
  text: string;
} | null;
type SyncRange = {
  startTime: number;
  endTime: number;
  incremental?: boolean;
};

const EMPTY_BINANCE_STATUS: BinanceApiStatus = {
  configured: false,
  apiKeyHint: null,
  lastSyncedAt: null,
  updatedAt: null,
};

const EMPTY_OKX_STATUS: OkxApiStatus = {
  configured: false,
  apiKeyHint: null,
  lastSyncedAt: null,
  updatedAt: null,
};

export function BinanceApiConnect({
  defaultSymbols,
  onSync,
  onOkxSync,
  disabled = false,
}: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const binanceTabId = useId();
  const okxTabId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ExchangeTab>("binance");
  const [binanceStatus, setBinanceStatus] =
    useState<BinanceApiStatus>(EMPTY_BINANCE_STATUS);
  const [okxStatus, setOkxStatus] = useState<OkxApiStatus>(EMPTY_OKX_STATUS);
  const [binanceApiKey, setBinanceApiKey] = useState("");
  const [binanceApiSecret, setBinanceApiSecret] = useState("");
  const [okxApiKey, setOkxApiKey] = useState("");
  const [okxApiSecret, setOkxApiSecret] = useState("");
  const [okxPassphrase, setOkxPassphrase] = useState("");
  const [okxRegion, setOkxRegion] = useState<OkxRegion>("global");
  const [latestDate] = useState(() => dateInputValue(Date.now()));
  const [startDate, setStartDate] = useState(() =>
    dateInputValue(Date.now() - 30 * 86_400_000),
  );
  const [endDate, setEndDate] = useState(() => dateInputValue(Date.now()));
  const [busy, setBusy] = useState<BusyState>(null);
  const [binanceFeedback, setBinanceFeedback] = useState<Feedback>(null);
  const [okxFeedback, setOkxFeedback] = useState<Feedback>(null);
  const [generalError, setGeneralError] = useState("");
  const [quickSummary, setQuickSummary] = useState("");
  const [exchangeProgress, setExchangeProgress] = useState<
    Partial<Record<ExchangeTab, ExchangeSyncProgress>>
  >({});

  const suggestedSymbols = useMemo(
    () => [...new Set(defaultSymbols.map(normalizeSymbol).filter(Boolean))],
    [defaultSymbols],
  );
  const hasConnectedExchange = binanceStatus.configured || okxStatus.configured;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!quickSummary) return;
    const timeout = window.setTimeout(() => setQuickSummary(""), 5_000);
    return () => window.clearTimeout(timeout);
  }, [quickSummary]);

  useEffect(() => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    let cancelled = false;
    void Promise.allSettled([
      api.getBinanceApiStatus(),
      api.getOkxApiStatus(),
    ]).then(([binanceResult, okxResult]) => {
      if (cancelled) return;
      if (binanceResult.status === "fulfilled") {
        setBinanceStatus(binanceResult.value);
      }
      if (okxResult.status === "fulfilled") {
        setOkxStatus(okxResult.value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const api = window.cryptoReviewDesktop;
    if (!api || typeof api.onExchangeSyncProgress !== "function") return;
    return api.onExchangeSyncProgress((progress) => {
      setExchangeProgress((current) => ({
        ...current,
        [progress.provider]: progress,
      }));
    });
  }, []);

  const clearCredentialFields = () => {
    setBinanceApiKey("");
    setBinanceApiSecret("");
    setOkxApiKey("");
    setOkxApiSecret("");
    setOkxPassphrase("");
    setOkxRegion("global");
  };

  const openDialog = async () => {
    setOpen(true);
    setGeneralError("");
    setBinanceFeedback(null);
    setOkxFeedback(null);
    setQuickSummary("");
    const api = window.cryptoReviewDesktop;
    if (!api) {
      setBinanceStatus(EMPTY_BINANCE_STATUS);
      setOkxStatus(EMPTY_OKX_STATUS);
      setGeneralError(
        "交易所 API 只在本地桌面版可用，浏览器页面不会接收或保存密钥。",
      );
      return;
    }

    setBusy("status");
    const [binanceResult, okxResult] = await Promise.allSettled([
      api.getBinanceApiStatus(),
      api.getOkxApiStatus(),
    ]);
    if (binanceResult.status === "fulfilled") {
      setBinanceStatus(binanceResult.value);
    } else {
      setBinanceFeedback({
        kind: "error",
        text: errorText(binanceResult.reason, "无法读取 Binance API 连接状态"),
      });
    }
    if (okxResult.status === "fulfilled") {
      setOkxStatus(okxResult.value);
    } else {
      setOkxFeedback({
        kind: "error",
        text: errorText(okxResult.reason, "无法读取 OKX API 连接状态"),
      });
    }
    setBusy(null);
  };

  const closeDialog = () => {
    setOpen(false);
    clearCredentialFields();
    setGeneralError("");
    setBinanceFeedback(null);
    setOkxFeedback(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const configureBinance = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    setBusy("binance-configure");
    setBinanceFeedback(null);
    try {
      const nextStatus = await api.configureBinanceApi({
        apiKey: binanceApiKey,
        apiSecret: binanceApiSecret,
      });
      setBinanceStatus(nextStatus);
      setBinanceApiKey("");
      setBinanceApiSecret("");
      setBinanceFeedback({
        kind: "success",
        text: "连接验证成功。Binance 密钥已由系统安全存储加密，仅保存在本机。",
      });
    } catch (cause) {
      setBinanceFeedback({
        kind: "error",
        text: errorText(cause, "Binance API 连接失败"),
      });
    } finally {
      setBusy(null);
    }
  };

  const configureOkx = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    setBusy("okx-configure");
    setOkxFeedback(null);
    try {
      const nextStatus = await api.configureOkxApi({
        apiKey: okxApiKey,
        apiSecret: okxApiSecret,
        passphrase: okxPassphrase,
        region: okxRegion as OkxApiRegion,
      });
      setOkxStatus(nextStatus);
      setOkxApiKey("");
      setOkxApiSecret("");
      setOkxPassphrase("");
      setOkxFeedback({
        kind: "success",
        text: "连接验证成功。OKX 凭证已由系统安全存储加密，仅保存在本机。",
      });
    } catch (cause) {
      setOkxFeedback({
        kind: "error",
        text: errorText(cause, "OKX API 连接失败"),
      });
    } finally {
      setBusy(null);
    }
  };

  const syncBinanceData = async (
    api: CryptoReviewDesktopApi,
    range: SyncRange,
  ) => {
    const result = await api.syncBinanceOrders({
      symbols: suggestedSymbols,
      ...range,
    });
    setExchangeProgress((current) => ({
      ...current,
      binance: {
        provider: "binance",
        stage: "rebuilding",
        message: "正在重建 Binance 复盘",
      },
    }));
    await onSync(result);
    setExchangeProgress((current) => ({
      ...current,
      binance: {
        provider: "binance",
        stage: "complete",
        message: "Binance 更新完成",
      },
    }));
    setBinanceStatus(result.status);
    return formatBinanceSyncResult(result);
  };

  const syncOkxData = async (
    api: CryptoReviewDesktopApi,
    range: SyncRange,
  ) => {
    const result = await api.syncOkxOrders(range);
    setExchangeProgress((current) => ({
      ...current,
      okx: {
        provider: "okx",
        stage: "rebuilding",
        message: "正在重建 OKX 复盘",
      },
    }));
    await onOkxSync(result);
    setExchangeProgress((current) => ({
      ...current,
      okx: {
        provider: "okx",
        stage: "complete",
        message: "OKX 更新完成",
      },
    }));
    setOkxStatus(result.status);
    return formatOkxSyncResult(result);
  };

  const syncBinanceOrders = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    setBusy("binance-sync");
    setBinanceFeedback(null);
    setExchangeProgress((current) => ({ ...current, binance: undefined }));
    try {
      const text = await syncBinanceData(api, getSyncRange(startDate, endDate));
      setBinanceFeedback({ kind: "success", text });
    } catch (cause) {
      setBinanceFeedback({
        kind: "error",
        text: errorText(cause, "Binance 订单同步失败"),
      });
    } finally {
      setBusy(null);
    }
  };

  const syncOkxOrders = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    setBusy("okx-sync");
    setOkxFeedback(null);
    setExchangeProgress((current) => ({ ...current, okx: undefined }));
    try {
      const text = await syncOkxData(api, getSyncRange(startDate, endDate));
      setOkxFeedback({ kind: "success", text });
    } catch (cause) {
      setOkxFeedback({
        kind: "error",
        text: errorText(cause, "OKX 订单同步失败"),
      });
    } finally {
      setBusy(null);
    }
  };

  const quickSync = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api || !hasConnectedExchange) {
      await openDialog();
      return;
    }

    let range: SyncRange;
    try {
      range = { ...getSyncRange(startDate, endDate), incremental: true };
    } catch (cause) {
      setGeneralError(errorText(cause, "同步日期范围无效"));
      setOpen(true);
      return;
    }

    setBusy("quick-sync");
    setGeneralError("");
    setBinanceFeedback(null);
    setOkxFeedback(null);
    setQuickSummary("");
    setExchangeProgress({});

    const jobs: Array<{
      exchange: ExchangeTab;
      promise: Promise<string>;
    }> = [];
    if (binanceStatus.configured) {
      jobs.push({
        exchange: "binance",
        promise: syncBinanceData(api, range),
      });
    }
    if (okxStatus.configured) {
      jobs.push({
        exchange: "okx",
        promise: syncOkxData(api, range),
      });
    }

    const results = await Promise.allSettled(jobs.map((job) => job.promise));
    const summaries: string[] = [];
    let hasFailure = false;
    results.forEach((result, index) => {
      const exchange = jobs[index].exchange;
      if (result.status === "fulfilled") {
        const feedback = { kind: "success" as const, text: result.value };
        if (exchange === "binance") {
          setBinanceFeedback(feedback);
          summaries.push("Binance 更新成功");
        } else {
          setOkxFeedback(feedback);
          summaries.push("OKX 更新成功");
        }
        return;
      }

      hasFailure = true;
      if (exchange === "binance") {
        const text = errorText(result.reason, "更新 Binance 数据失败");
        setBinanceFeedback({ kind: "error", text });
        summaries.push(`Binance 更新失败：${text}`);
      } else {
        const text = errorText(result.reason, "更新 OKX 数据失败");
        setOkxFeedback({ kind: "error", text });
        summaries.push(`OKX 更新失败：${text}`);
      }
    });

    setQuickSummary(summaries.join("；"));
    setBusy(null);
    if (hasFailure) setOpen(true);
  };

  const removeBinanceConnection = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    setBusy("binance-remove");
    setBinanceFeedback(null);
    try {
      setBinanceStatus(await api.removeBinanceApi());
      setBinanceApiKey("");
      setBinanceApiSecret("");
      setBinanceFeedback({
        kind: "success",
        text: "已删除 Binance 本机加密凭证；已同步订单和复盘仍会保留。",
      });
    } catch (cause) {
      setBinanceFeedback({
        kind: "error",
        text: errorText(cause, "无法断开 Binance API"),
      });
    } finally {
      setBusy(null);
    }
  };

  const removeOkxConnection = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api) return;
    setBusy("okx-remove");
    setOkxFeedback(null);
    try {
      setOkxStatus(await api.removeOkxApi());
      setOkxApiKey("");
      setOkxApiSecret("");
      setOkxPassphrase("");
      setOkxFeedback({
        kind: "success",
        text: "已删除 OKX 本机加密凭证；已同步订单和复盘仍会保留。",
      });
    } catch (cause) {
      setOkxFeedback({
        kind: "error",
        text: errorText(cause, "无法断开 OKX API"),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className={styles.triggerGroup}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.triggerButton}
          onClick={() => void openDialog()}
          disabled={disabled}
          aria-label="连接交易所 API"
          title="连接 Binance 或 OKX 只读 API"
        >
          <Link2 size={15} />
        </button>
        <button
          type="button"
          className={styles.updateButton}
          onClick={() => void quickSync()}
          disabled={disabled || busy !== null}
          aria-label="更新已连接交易所数据"
          title={
            hasConnectedExchange
              ? "按当前日期范围更新 Binance 数据与 OKX 数据"
              : "请先连接交易所 API"
          }
        >
          <RefreshCw
            size={14}
            className={busy === "quick-sync" ? styles.spin : undefined}
          />
        </button>
        {(quickSummary || busy === "quick-sync") && (
          <span className={styles.quickFeedback} role="status">
            {quickSummary || formatCombinedProgress(exchangeProgress)}
          </span>
        )}
      </div>

      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        <div className={styles.dialogShell}>
          <header className={styles.dialogHeader}>
            <div>
              <span>LOCAL · READ ONLY</span>
              <h2 id={titleId}>交易所只读 API</h2>
              <p id={descriptionId}>
                在一个入口管理 Binance U 本位与 OKX USDT 永续记录同步。
              </p>
            </div>
            <button type="button" onClick={closeDialog} aria-label="关闭交易所 API 窗口">
              <X size={17} />
            </button>
          </header>

          <div className={styles.securityNotice}>
            <ShieldCheck size={17} />
            <div>
              <strong>只读同步，不会下单</strong>
              <span>
                API Key、Secret 与 Passphrase 不会上传，也不会写入 localStorage
                或日志；仅由桌面主进程签名并使用系统安全存储加密。建议关闭交易和提现权限，并设置
                IP 白名单。
              </span>
            </div>
          </div>

          <div className={styles.content}>
            <div className={styles.tabs} role="tablist" aria-label="选择交易所">
              <button
                id={binanceTabId}
                type="button"
                role="tab"
                aria-selected={activeTab === "binance"}
                aria-controls={`${binanceTabId}-panel`}
                className={activeTab === "binance" ? styles.activeTab : undefined}
                onClick={() => setActiveTab("binance")}
              >
                Binance
                <span className={binanceStatus.configured ? styles.connected : undefined}>
                  {binanceStatus.configured ? "已连接" : "未连接"}
                </span>
              </button>
              <button
                id={okxTabId}
                type="button"
                role="tab"
                aria-selected={activeTab === "okx"}
                aria-controls={`${okxTabId}-panel`}
                className={activeTab === "okx" ? styles.activeTab : undefined}
                onClick={() => setActiveTab("okx")}
              >
                OKX
                <span className={okxStatus.configured ? styles.connected : undefined}>
                  {okxStatus.configured ? "已连接" : "未连接"}
                </span>
              </button>
            </div>

            {activeTab === "binance" ? (
              <section
                id={`${binanceTabId}-panel`}
                role="tabpanel"
                aria-labelledby={binanceTabId}
                className={styles.panel}
              >
                {!binanceStatus.configured ? (
                  <>
                    <div className={styles.panelTitle}>
                      <KeyRound size={16} />
                      <div>
                        <strong>连接 Binance 只读 API</strong>
                        <span>保存前会验证签名与 USER_DATA 权限</span>
                      </div>
                    </div>
                    <label>
                      <span>API Key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={binanceApiKey}
                        onChange={(event) => setBinanceApiKey(event.target.value)}
                        placeholder="输入 Binance API Key"
                      />
                    </label>
                    <label>
                      <span>Secret Key</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={binanceApiSecret}
                        onChange={(event) => setBinanceApiSecret(event.target.value)}
                        placeholder="输入 Binance Secret Key"
                      />
                    </label>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={
                        busy !== null || !binanceApiKey || !binanceApiSecret
                      }
                      onClick={() => void configureBinance()}
                    >
                      {busy === "binance-configure" && (
                        <RefreshCw size={14} className={styles.spin} />
                      )}
                      保存并验证
                    </button>
                  </>
                ) : (
                  <>
                    <ConnectionStatus status={binanceStatus} />
                    <DateRangeFields
                      latestDate={latestDate}
                      startDate={startDate}
                      endDate={endDate}
                      onStartDateChange={setStartDate}
                      onEndDateChange={setEndDate}
                    />
                    <p className={styles.limitNote}>
                      手动同步读取所选完整日期范围；顶部更新按钮会从上次成功时间增量读取，并自动补查仍在活动的订单。
                    </p>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={busy !== null}
                        onClick={() => void syncBinanceOrders()}
                      >
                        {busy === "binance-sync" ? (
                          <RefreshCw size={14} className={styles.spin} />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        同步基础委托与条件单
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={busy !== null}
                        onClick={() => void removeBinanceConnection()}
                      >
                        <Unplug size={14} />
                        断开连接
                      </button>
                    </div>
                  </>
                )}
              </section>
            ) : (
              <section
                id={`${okxTabId}-panel`}
                role="tabpanel"
                aria-labelledby={okxTabId}
                className={styles.panel}
              >
                {!okxStatus.configured ? (
                  <>
                    <div className={styles.panelTitle}>
                      <KeyRound size={16} />
                      <div>
                        <strong>连接 OKX 只读 API</strong>
                        <span>保存前会验证签名、Passphrase 与读取权限</span>
                      </div>
                    </div>
                    <label>
                      <span>API Key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={okxApiKey}
                        onChange={(event) => setOkxApiKey(event.target.value)}
                        placeholder="输入 OKX API Key"
                      />
                    </label>
                    <label>
                      <span>Secret Key</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={okxApiSecret}
                        onChange={(event) => setOkxApiSecret(event.target.value)}
                        placeholder="输入 OKX Secret Key"
                      />
                    </label>
                    <label>
                      <span>Passphrase</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={okxPassphrase}
                        onChange={(event) => setOkxPassphrase(event.target.value)}
                        placeholder="输入创建 API 时设置的 Passphrase"
                      />
                    </label>
                    <label>
                      <span>账户区域</span>
                      <select
                        value={okxRegion}
                        onChange={(event) =>
                          setOkxRegion(event.target.value as OkxRegion)
                        }
                      >
                        <option value="global">Global · openapi.okx.com</option>
                        <option value="us">US · us.okx.com</option>
                        <option value="eea">EEA · eea.okx.com</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={
                        busy !== null ||
                        !okxApiKey ||
                        !okxApiSecret ||
                        !okxPassphrase
                      }
                      onClick={() => void configureOkx()}
                    >
                      {busy === "okx-configure" && (
                        <RefreshCw size={14} className={styles.spin} />
                      )}
                      保存并验证
                    </button>
                  </>
                ) : (
                  <>
                    <ConnectionStatus status={okxStatus} />
                    <DateRangeFields
                      latestDate={latestDate}
                      startDate={startDate}
                      endDate={endDate}
                      onStartDateChange={setStartDate}
                      onEndDateChange={setEndDate}
                    />
                    <p className={styles.limitNote}>
                      手动同步读取所选完整日期范围；顶部更新按钮会从上次成功时间增量读取。USDT 永续合约信息会在本机短期缓存。
                    </p>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={busy !== null}
                        onClick={() => void syncOkxOrders()}
                      >
                        {busy === "okx-sync" ? (
                          <RefreshCw size={14} className={styles.spin} />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        同步基础委托与条件单
                      </button>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={busy !== null}
                        onClick={() => void removeOkxConnection()}
                      >
                        <Unplug size={14} />
                        断开连接
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}

            {(generalError || binanceFeedback || okxFeedback ||
              (busy !== null && (exchangeProgress.binance || exchangeProgress.okx))) && (
              <div className={styles.feedbackStack}>
                {busy !== null && exchangeProgress.binance && (
                  <SyncProgress progress={exchangeProgress.binance} label="Binance" />
                )}
                {busy !== null && exchangeProgress.okx && (
                  <SyncProgress progress={exchangeProgress.okx} label="OKX" />
                )}
                {generalError && (
                  <div
                    className={`${styles.feedback} ${styles.error}`}
                    role="status"
                  >
                    {generalError}
                  </div>
                )}
                {binanceFeedback && (
                  <div
                    className={`${styles.feedback} ${
                      binanceFeedback.kind === "error" ? styles.error : ""
                    }`}
                    role="status"
                  >
                    <strong>Binance</strong>
                    <span>{binanceFeedback.text}</span>
                  </div>
                )}
                {okxFeedback && (
                  <div
                    className={`${styles.feedback} ${
                      okxFeedback.kind === "error" ? styles.error : ""
                    }`}
                    role="status"
                  >
                    <strong>OKX</strong>
                    <span>{okxFeedback.text}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}

function ConnectionStatus({
  status,
}: {
  status: BinanceApiStatus | OkxApiStatus;
}) {
  return (
    <div className={styles.connectedRow}>
      <div>
        <i />
        <strong>已连接 {status.apiKeyHint}</strong>
      </div>
      <span>
        {status.lastSyncedAt
          ? `上次同步 ${new Date(status.lastSyncedAt).toLocaleString("zh-CN")}`
          : "尚未同步"}
      </span>
    </div>
  );
}

function SyncProgress({
  progress,
  label,
}: {
  progress: ExchangeSyncProgress;
  label: string;
}) {
  const determinate = Number.isInteger(progress.completed) &&
    Number.isInteger(progress.total) &&
    Number(progress.total) > 0;
  return (
    <div className={styles.syncProgress} role="status">
      <div>
        <strong>{label}</strong>
        <span>{progress.message}</span>
      </div>
      <progress
        {...(determinate
          ? { value: Number(progress.completed), max: Number(progress.total) }
          : {})}
      />
    </div>
  );
}

function DateRangeFields({
  latestDate,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: {
  latestDate: string;
  startDate: string;
  endDate: string;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
}) {
  return (
    <div className={styles.dateGrid}>
      <label>
        <span>开始日期</span>
        <input
          type="date"
          max={latestDate}
          value={startDate}
          onChange={(event) => onStartDateChange(event.target.value)}
        />
      </label>
      <label>
        <span>结束日期</span>
        <input
          type="date"
          max={latestDate}
          value={endDate}
          onChange={(event) => onEndDateChange(event.target.value)}
        />
      </label>
    </div>
  );
}

function getSyncRange(startDate: string, endDate: string): SyncRange {
  const startTime = new Date(`${startDate}T00:00:00+08:00`).getTime();
  const requestedEndTime = new Date(`${endDate}T23:59:59.999+08:00`).getTime();
  const endTime = Math.min(requestedEndTime, Date.now());
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime > endTime
  ) {
    throw new Error("同步日期范围无效。");
  }
  return { startTime, endTime };
}

function formatBinanceSyncResult(result: BinanceApiSyncResult) {
  return `更新 Binance 数据成功：自动发现 ${result.symbols.length} 个交易对，同步 ${result.normalOrderCount} 条基础委托、${result.algoOrderCount} 条条件单、${result.fillCount} 笔成交、${result.fundingFeeCount} 条资金费流水。`;
}

function formatOkxSyncResult(result: OkxApiSyncResult) {
  const warningText = result.warnings?.length
    ? `；另有 ${result.warnings.length} 项提示`
    : "";
  return `更新 OKX 数据成功：自动发现 ${result.symbols.length} 个交易对，同步 ${result.normalOrderCount} 条基础委托、${result.algoOrderCount} 条条件单、${result.fillCount} 笔成交${warningText}。`;
}

function formatCombinedProgress(
  progress: Partial<Record<ExchangeTab, ExchangeSyncProgress>>,
) {
  return [progress.binance?.message, progress.okx?.message]
    .filter(Boolean)
    .join("；") || "正在准备增量更新…";
}

function dateInputValue(timestamp: number) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeSymbol(value: string) {
  return String(value ?? "").toUpperCase().replace(/[\s/_-]/g, "");
}

function errorText(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
