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
import { extractSmartMoneyProfileId, type SmartMoneySourceConfig } from "@/lib/smart-money-profile.mjs";
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
  onSmartMoneyImport: (sourceUrl: string) => void | Promise<void>;
  onSaveSmartMoney: (config: SmartMoneySourceConfig | null) => void;
  onSyncSmartMoney: (config: SmartMoneySourceConfig, options?: { fullHistory?: boolean }) => void | Promise<void>;
};

export function LeadPortfolioMonitor({
  profile,
  disabled = false,
  onSave,
  onSync,
  onSmartMoneyImport,
  onSaveSmartMoney,
  onSyncSmartMoney,
}: LeadPortfolioMonitorProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState(
    profile.smartMoneySource?.sourceUrl ?? profile.copyTradeMonitor?.sourceUrl ?? "",
  );
  const [intervalSeconds, setIntervalSeconds] = useState<30 | 60 | 300>(
    profile.smartMoneySource?.intervalSeconds ?? profile.copyTradeMonitor?.intervalSeconds ?? 60,
  );
  const [enabled, setEnabled] = useState(
    profile.smartMoneySource?.enabled ?? profile.copyTradeMonitor?.enabled ?? true,
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
    setSourceUrl(
      profile.smartMoneySource?.sourceUrl ?? profile.copyTradeMonitor?.sourceUrl ?? "",
    );
    setIntervalSeconds(profile.smartMoneySource?.intervalSeconds ?? profile.copyTradeMonitor?.intervalSeconds ?? 60);
    setEnabled(profile.smartMoneySource?.enabled ?? profile.copyTradeMonitor?.enabled ?? true);
    setError("");
  }, [profile.id, profile.copyTradeMonitor, profile.smartMoneySource]);

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
      if (isSmartMoneyProfileUrl(sourceUrl)) {
        const topTraderId = extractSmartMoneyProfileId(sourceUrl);
        if (profile.smartMoneySource?.topTraderId !== topTraderId) {
          throw new Error("请先点击“立即同步”导入这个聪明钱主页，再保存自动更新设置。");
        }
        onSaveSmartMoney({ ...profile.smartMoneySource, enabled, intervalSeconds });
        setError("");
        return;
      }
      const config = buildConfig();
      onSave(config);
      setError("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "带单主页配置无效");
    }
  };

  const syncNow = async () => {
    try {
      setSyncing(true);
      setError("");
      if (isSmartMoneyProfileUrl(sourceUrl)) {
        const topTraderId = extractSmartMoneyProfileId(sourceUrl);
        if (profile.smartMoneySource?.topTraderId === topTraderId) {
          const config = { ...profile.smartMoneySource, enabled, intervalSeconds };
          onSaveSmartMoney(config);
          await onSyncSmartMoney(config, { fullHistory: true });
        } else {
          await onSmartMoneyImport(sourceUrl.trim());
        }
        return;
      }
      const config = buildConfig();
      onSave(config);
      await onSync(config, { fullHistory: true });
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "公开带单同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const removeBinding = () => {
    if (profile.smartMoneySource) onSaveSmartMoney(null);
    else onSave(null);
    setSourceUrl("");
    setEnabled(true);
    setError("");
  };

  const monitor = profile.smartMoneySource ?? profile.copyTradeMonitor;
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
        <span>{profile.smartMoneySource ? "登录并同步聪明钱" : "同步公开带单"}</span>
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
              <h2 id={titleId}>Binance 带单与聪明钱主页</h2>
              <p id={descriptionId}>
                两类主页都会创建独立用户；聪明钱主页还会读取共享的当前仓位与最近操作。
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
              <span>保存方式</span>
              <strong>自动创建或更新独立复盘用户</strong>
              <small>同一主页重复同步只会更新对应用户，不会写入“我的账户”。</small>
            </div>

            <label className={styles.field}>
              <span><Link2 size={13} />Binance 主页链接</span>
              <input
                value={sourceUrl}
                onChange={(event) => {
                  setSourceUrl(event.target.value);
                  setError("");
                }}
                placeholder="https://www.binance.com/zh-CN/smart-money/profile/..."
                spellCheck={false}
                autoComplete="off"
              />
              <small>支持公开带单或聪明钱主页；聪明钱登录保存在本机，同步完成后隐藏 Binance 窗口并复用登录。</small>
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
                  <strong>{profile.smartMoneySource?.traderName || profile.copyTradeMonitor?.nickname || statusLabel}</strong>
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
                {syncing
                  ? "正在同步…"
                  : profile.smartMoneySource
                    ? "登录并同步"
                    : "立即同步"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    </>
  );
}

function isSmartMoneyProfileUrl(value: string) {
  return /\/smart-money\/profile\//i.test(value);
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
