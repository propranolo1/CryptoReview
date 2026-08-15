"use client";

import { Clock3, Link2, Radio, RefreshCw, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  extractLeadPortfolioId,
  type CopyTradeMonitorConfig,
} from "@/lib/copy-trade-monitor.mjs";
import type { TradeProfile } from "@/lib/trade-profiles.mjs";
import styles from "./LeadPortfolioMonitor.module.css";

type LeadPortfolioMonitorProps = {
  profile: TradeProfile;
  disabled?: boolean;
  onSave: (config: CopyTradeMonitorConfig | null) => void;
  onSync: (
    config: CopyTradeMonitorConfig,
    options?: { fullHistory?: boolean },
  ) => void | Promise<void>;
};

export function LeadPortfolioMonitor({
  profile,
  disabled = false,
  onSave,
  onSync,
}: LeadPortfolioMonitorProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState(
    profile.copyTradeMonitor?.sourceUrl ?? "",
  );
  const [intervalSeconds, setIntervalSeconds] = useState<30 | 60 | 300>(
    profile.copyTradeMonitor?.intervalSeconds ?? 60,
  );
  const [enabled, setEnabled] = useState(
    profile.copyTradeMonitor?.enabled ?? true,
  );
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    setSourceUrl(profile.copyTradeMonitor?.sourceUrl ?? "");
    setIntervalSeconds(profile.copyTradeMonitor?.intervalSeconds ?? 60);
    setEnabled(profile.copyTradeMonitor?.enabled ?? true);
    setError("");
  }, [profile.id, profile.copyTradeMonitor]);

  const closeDialog = () => {
    setOpen(false);
    setError("");
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const buildConfig = (): CopyTradeMonitorConfig => {
    const portfolioId = extractLeadPortfolioId(sourceUrl);
    return {
      enabled,
      sourceUrl: sourceUrl.trim(),
      portfolioId,
      intervalSeconds,
      ...(profile.copyTradeMonitor?.portfolioId === portfolioId
        ? {
            ...(profile.copyTradeMonitor.nickname
              ? { nickname: profile.copyTradeMonitor.nickname }
              : {}),
            ...(profile.copyTradeMonitor.lastSyncedAt
              ? { lastSyncedAt: profile.copyTradeMonitor.lastSyncedAt }
              : {}),
            ...(profile.copyTradeMonitor.lastAttemptAt
              ? { lastAttemptAt: profile.copyTradeMonitor.lastAttemptAt }
              : {}),
            ...(profile.copyTradeMonitor.lastOrderTime !== undefined
              ? { lastOrderTime: profile.copyTradeMonitor.lastOrderTime }
              : {}),
            ...(profile.copyTradeMonitor.lastSnapshot
              ? { lastSnapshot: profile.copyTradeMonitor.lastSnapshot }
              : {}),
          }
        : {}),
    };
  };

  const saveOnly = () => {
    try {
      const config = buildConfig();
      onSave(config);
      setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "带单主页配置无效");
    }
  };

  const syncNow = async () => {
    try {
      const config = buildConfig();
      setSyncing(true);
      setError("");
      onSave(config);
      await onSync(config, { fullHistory: true });
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "公开带单同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const removeBinding = () => {
    onSave(null);
    setSourceUrl("");
    setEnabled(true);
    setError("");
  };

  const monitor = profile.copyTradeMonitor;
  const statusLabel = monitor
    ? monitor.enabled
      ? "自动更新中"
      : "已绑定 · 自动更新关闭"
    : "未绑定";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.triggerButton}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Radio size={14} />
        <span>同步公开带单</span>
        {monitor && <i aria-label={statusLabel} />}
      </button>

      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => setOpen(false)}
      >
        <div className={styles.dialogShell}>
          <header>
            <div>
              <span className={styles.eyebrow}>PUBLIC COPY TRADING</span>
              <h2 id={titleId}>Binance 公开带单主页</h2>
              <p id={descriptionId}>
                读取公开成交与当前仓位，自动同步到“小洪”这类独立复盘用户。
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeDialog}
              aria-label="关闭公开带单设置"
            >
              <X size={17} />
            </button>
          </header>

          <section className={styles.content}>
            <div className={styles.targetCard}>
              <span>同步目标</span>
              <strong>同步到“{profile.name}”</strong>
              <small>成交、复盘和表现统计不会写入其他用户。</small>
            </div>

            <label className={styles.field}>
              <span><Link2 size={13} />公开主页链接</span>
              <input
                value={sourceUrl}
                onChange={(event) => {
                  setSourceUrl(event.target.value);
                  setError("");
                }}
                placeholder="https://www.binance.com/zh-CN/copy-trading/lead-details/..."
                spellCheck={false}
                autoComplete="off"
              />
              <small>粘贴带单员公开主页链接，不需要对方账户 API Key。</small>
            </label>

            <div className={styles.settingsRow}>
              <label className={styles.field}>
                <span><Clock3 size={13} />自动更新频率</span>
                <select
                  value={intervalSeconds}
                  onChange={(event) =>
                    setIntervalSeconds(Number(event.target.value) as 30 | 60 | 300)}
                >
                  <option value={30}>每 30 秒</option>
                  <option value={60}>每 1 分钟</option>
                  <option value={300}>每 5 分钟</option>
                </select>
              </label>

              <label className={styles.switchField}>
                <span>
                  <strong>自动更新</strong>
                  <small>软件打开时在本机轮询</small>
                </span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
              </label>
            </div>

            {monitor && (
              <div className={styles.statusCard} role="status">
                <i className={monitor.enabled ? styles.online : styles.paused} />
                <div>
                  <strong>{monitor.nickname || statusLabel}</strong>
                  <span>
                    {monitor.lastSyncedAt
                      ? `最近同步：${formatLocalTime(monitor.lastSyncedAt)}`
                      : statusLabel}
                  </span>
                </div>
              </div>
            )}

            {(error || monitor?.lastError) && (
              <p className={styles.error} role="alert">{error || monitor?.lastError}</p>
            )}
          </section>

          <footer>
            <div>
              {monitor && (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={removeBinding}
                  disabled={syncing}
                >
                  解除绑定
                </button>
              )}
            </div>
            <div>
              <button
                type="button"
                onClick={saveOnly}
                disabled={syncing || sourceUrl.trim() === ""}
              >
                保存设置
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void syncNow()}
                disabled={syncing || sourceUrl.trim() === ""}
              >
                <RefreshCw size={14} className={syncing ? styles.spinning : undefined} />
                {syncing ? "正在同步…" : "立即同步"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    </>
  );
}

function formatLocalTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}
