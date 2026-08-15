"use client";

import { Activity, Link2, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_SMART_MONEY_SOURCE_URL } from "@/lib/smart-money-profile.mjs";
import styles from "./LeadPortfolioMonitor.module.css";

type SmartMoneyImportProps = {
  disabled?: boolean;
  onImport: (sourceUrl: string) => void | Promise<void>;
};

export function SmartMoneyImport({
  disabled = false,
  onImport,
}: SmartMoneyImportProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_SMART_MONEY_SOURCE_URL);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const closeDialog = () => {
    setOpen(false);
    setError("");
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const importProfile = async () => {
    try {
      setSyncing(true);
      setError("");
      await onImport(sourceUrl.trim());
      closeDialog();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "聪明钱主页同步失败");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.triggerButton}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <Activity size={14} />
        <span>同步聪明钱</span>
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
              <span className={styles.eyebrow}>BINANCE SMART MONEY</span>
              <h2 id={titleId}>同步聪明钱主页</h2>
              <p id={descriptionId}>
                输入主页 URL 后创建独立本地用户，并完整同步其关联的公开 U 本位成交生成复盘。
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeDialog}
              aria-label="关闭聪明钱同步"
            >
              <X size={17} />
            </button>
          </header>

          <section className={styles.content}>
            <div className={styles.targetCard}>
              <span>保存方式</span>
              <strong>自动创建或更新独立复盘用户</strong>
              <small>同一 URL 重复同步只会更新原用户，不会重复创建交易。</small>
            </div>

            <label className={styles.field}>
              <span><Link2 size={13} />聪明钱主页链接</span>
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
              <small>
                仅使用主页公开资料及其官方关联的公开合约带单成交；没有关联档案时不会猜测成交。
              </small>
            </label>

            {error && <p className={styles.error} role="alert">{error}</p>}
          </section>

          <footer>
            <div />
            <div>
              <button type="button" onClick={closeDialog} disabled={syncing}>取消</button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void importProfile()}
                disabled={syncing || sourceUrl.trim() === ""}
              >
                <RefreshCw size={14} className={syncing ? styles.spinning : undefined} />
                {syncing ? "正在同步…" : "创建用户并同步"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    </>
  );
}
