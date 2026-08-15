"use client";

import { Download, RefreshCw, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import styles from "./AppUpdateControl.module.css";

export function AppUpdateControl() {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    const api = window.cryptoReviewDesktop;
    if (!api?.getUpdateStatus) return;
    try {
      setStatus(await api.getUpdateStatus());
    } catch {
      // 网页模式或桌面窗口正在退出时不显示更新入口。
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  if (!status) return null;

  const handleClick = async () => {
    const api = window.cryptoReviewDesktop;
    if (!api || busy) return;
    setBusy(true);
    try {
      if (status.canInstall && status.state === "downloaded") {
        setStatus(await api.installUpdate());
      } else if (status.available && !status.canAutoUpdate) {
        await api.openUpdateRelease();
      } else {
        setStatus(await api.checkForUpdates());
      }
    } finally {
      setBusy(false);
    }
  };

  const isWorking = busy || status.state === "checking" || status.state === "downloading";
  const label = status.state === "downloaded"
    ? "重启更新"
    : status.available && !status.canAutoUpdate
      ? `下载 v${status.latestVersion}`
      : status.state === "downloading"
        ? `下载 v${status.latestVersion}`
        : `v${status.currentVersion}`;

  return (
    <button
      type="button"
      className={`${styles.control} ${status.available ? styles.available : ""}`}
      onClick={() => void handleClick()}
      disabled={busy || status.state === "installing"}
      aria-label={status.state === "downloaded" ? "重启并安装更新" : "检查软件更新"}
      title={status.message}
    >
      {status.state === "downloaded" || (status.available && !status.canAutoUpdate)
        ? <Download size={13} />
        : isWorking
          ? <RotateCw className={styles.spinning} size={13} />
          : <RefreshCw size={13} />}
      <span>{label}</span>
    </button>
  );
}
