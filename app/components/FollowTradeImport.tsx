"use client";

import { ImagePlus, RotateCcw, ShieldCheck, Users, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type {
  FollowTradeAction,
  FollowTradeEvent,
} from "@/lib/follow-trade-records.mjs";
import {
  recognizeFollowTradeImages,
  type FollowTradeOcrProgress,
} from "@/app/lib/follow-trade-ocr";
import styles from "./ConditionOrderImport.module.css";

type FollowTradeImportProps = {
  profileName: string;
  onConfirm: (events: FollowTradeEvent[]) => void | Promise<void>;
  disabled?: boolean;
};

type DialogStage = "idle" | "processing" | "review" | "error";

const ACTION_LABELS: Record<FollowTradeAction, string> = {
  openLong: "开多",
  closeLong: "平多",
  openShort: "开空",
  closeShort: "平空",
};

const EMPTY_PROGRESS: FollowTradeOcrProgress = {
  percent: 0,
  currentFile: null,
  fileIndex: 0,
  fileCount: 0,
  message: "准备本地识别",
};

const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function FollowTradeImport({
  profileName,
  onConfirm,
  disabled = false,
}: FollowTradeImportProps) {
  const titleId = useId();
  const descriptionId = useId();
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stage, setStage] = useState<DialogStage>("idle");
  const [progress, setProgress] = useState(EMPTY_PROGRESS);
  const [events, setEvents] = useState<FollowTradeEvent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const writableIds = useMemo(() => new Set(
    events.filter(isWritableEvent).map((event) => event.id),
  ), [events]);
  const selectedWritableCount = [...selectedIds]
    .filter((id) => writableIds.has(id)).length;
  const allWritableSelected = writableIds.size > 0 &&
    [...writableIds].every((id) => selectedIds.has(id));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const chooseImages = () => imageInputRef.current?.click();
  const chooseReplacementImages = () => {
    setDialogOpen(false);
    window.setTimeout(() => imageInputRef.current?.click(), 0);
  };

  const handleImagesChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setDialogOpen(true);
    setStage("processing");
    setProgress({ ...EMPTY_PROGRESS, fileCount: files.length });
    setEvents([]);
    setSelectedIds(new Set());
    setErrorMessage("");
    setReviewError("");

    try {
      const recognized = await recognizeFollowTradeImages(
        files,
        setProgress,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setEvents(recognized);
      setSelectedIds(new Set(recognized.filter(isWritableEvent).map((item) => item.id)));
      setStage("review");
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "本地识别失败，请换一张更清晰的跟单记录截图重试。",
      );
      setStage("error");
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const closeDialog = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setDialogOpen(false);
    setStage("idle");
    setSubmitting(false);
    setReviewError("");
    window.setTimeout(() => triggerButtonRef.current?.focus(), 0);
  };

  const updateEvent = (id: string, patch: Partial<FollowTradeEvent>) => {
    setEvents((current) => current.map((event) =>
      event.id === id ? { ...event, ...patch } : event));
    setReviewError("");
  };

  const toggleSelected = (id: string) => {
    if (!writableIds.has(id)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of writableIds) {
        if (allWritableSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const confirmSelected = async () => {
    const selected = events.filter((event) =>
      selectedIds.has(event.id) && isWritableEvent(event));
    if (selected.length === 0) {
      setReviewError("请先勾选至少一条字段完整的跟单成交。");
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(selected);
      closeDialog();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "写入跟单记录失败。");
      setSubmitting(false);
    }
  };

  return (
    <>
      <input
        ref={imageInputRef}
        className={styles.hiddenInput}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        multiple
        onChange={handleImagesChange}
        aria-label="选择跟单交易时间线截图"
      />
      <button
        ref={triggerButtonRef}
        type="button"
        className={styles.triggerButton}
        onClick={chooseImages}
        disabled={disabled || stage === "processing"}
      >
        <Users size={14} />
        <span>识别跟单记录</span>
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
      >
        <div className={styles.dialogShell}>
          <header className={styles.dialogHeader}>
            <div>
              <span className={styles.eyebrow}>LOCAL OCR · COPY TRADING</span>
              <h2 id={titleId}>OCR 跟单记录校对</h2>
              <p id={descriptionId}>
                图片仅在本机识别，不会上传；本次记录将导入到“{profileName}”。
                多张截图可重复导入，已识别成交会稳定合并。
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeDialog}
              aria-label="关闭跟单记录校对"
            >
              <X size={17} />
            </button>
          </header>

          {stage === "processing" ? (
            <div className={styles.progressView}>
              <span className={styles.localBadge}>
                <ShieldCheck size={14} />图片留在当前设备
              </span>
              <strong>{progress.message}</strong>
              <span>
                {progress.currentFile
                  ? `${progress.fileIndex}/${progress.fileCount} · ${progress.currentFile}`
                  : "首次识别需要加载本地中英文模型，请稍候。"}
              </span>
              <div className={styles.progressTrack} aria-hidden="true">
                <i style={{ width: `${progress.percent}%` }} />
              </div>
              <b>{progress.percent}%</b>
            </div>
          ) : stage === "error" ? (
            <div className={styles.emptyView}>
              <strong>跟单记录识别没有完成</strong>
              <span>{errorMessage}</span>
              <button type="button" onClick={chooseReplacementImages}>
                <RotateCcw size={13} />重新选择截图
              </button>
            </div>
          ) : stage === "review" && events.length === 0 ? (
            <div className={styles.emptyView}>
              <strong>没有识别到跟单成交</strong>
              <span>请确认截图包含日期时间、“开启/关闭做多或做空”、均价和成交数量。</span>
              <button type="button" onClick={chooseReplacementImages}>
                <ImagePlus size={13} />换一张截图
              </button>
            </div>
          ) : stage === "review" ? (
            <>
              <div className={styles.reviewSummary}>
                <div>
                  <strong>识别到 {events.length} 条跟单成交</strong>
                  <span>请重点核对交易对、开平仓方向、成交数量和截图盈亏。</span>
                </div>
                <button type="button" onClick={chooseReplacementImages}>
                  <RotateCcw size={12} />重新识别
                </button>
              </div>
              <div className={styles.tableWrap}>
                <table className={`${styles.table} ${styles.followTable}`}>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={allWritableSelected}
                          onChange={toggleAll}
                          aria-label="全选可导入跟单成交"
                        />
                      </th>
                      <th>时间（UTC+8）</th>
                      <th>合约</th>
                      <th>方向</th>
                      <th>平均价格</th>
                      <th>成交数量</th>
                      <th>总价值</th>
                      <th>截图盈亏</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => {
                      const writable = writableIds.has(event.id);
                      return (
                        <tr
                          key={event.id}
                          className={writable ? styles.matchedRow : styles.unmatchedRow}
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(event.id)}
                              disabled={!writable}
                              onChange={() => toggleSelected(event.id)}
                              aria-label={`选择 ${event.symbol} ${ACTION_LABELS[event.action]}`}
                            />
                          </td>
                          <td>
                            <input
                              type="datetime-local"
                              step="1"
                              value={formatUtc8Input(event.time)}
                              onChange={(change) => {
                                const time = utc8InputToIso(change.target.value);
                                if (time) updateEvent(event.id, { time });
                              }}
                            />
                          </td>
                          <td>
                            <input
                              className={styles.symbolInput}
                              value={event.symbol}
                              onChange={(change) => updateEvent(event.id, {
                                symbol: change.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                              })}
                            />
                          </td>
                          <td>
                            <select
                              value={event.action}
                              onChange={(change) => updateEvent(event.id, {
                                action: change.target.value as FollowTradeAction,
                                realizedPnl: change.target.value.startsWith("open")
                                  ? null
                                  : event.realizedPnl,
                              })}
                            >
                              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              inputMode="decimal"
                              value={event.price}
                              onChange={(change) => updateEvent(event.id, {
                                price: nonNegativeNumber(change.target.value),
                              })}
                            />
                          </td>
                          <td>
                            <input
                              inputMode="decimal"
                              value={event.quantity}
                              onChange={(change) => updateEvent(event.id, {
                                quantity: nonNegativeNumber(change.target.value),
                              })}
                            />
                          </td>
                          <td>
                            <input
                              inputMode="decimal"
                              value={event.quoteQuantity}
                              onChange={(change) => updateEvent(event.id, {
                                quoteQuantity: nonNegativeNumber(change.target.value),
                              })}
                            />
                          </td>
                          <td>
                            <input
                              inputMode="decimal"
                              value={event.realizedPnl ?? ""}
                              placeholder={event.action.startsWith("open") ? "开仓无盈亏" : "待校对"}
                              disabled={event.action.startsWith("open")}
                              onChange={(change) => updateEvent(event.id, {
                                realizedPnl: nullableSignedNumber(change.target.value),
                              })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <footer className={styles.dialogActions}>
                <div>
                  <strong>已选 {selectedWritableCount} 条 · 导入到“{profileName}”</strong>
                  <span>截图片段不完整时会先保存成交，补齐开平仓后再自动生成复盘。</span>
                  {reviewError ? <em>{reviewError}</em> : null}
                </div>
                <div>
                  <button
                    type="button"
                    className={styles.cancelButton}
                    onClick={closeDialog}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className={styles.confirmButton}
                    disabled={submitting || selectedWritableCount === 0}
                    onClick={confirmSelected}
                  >
                    {submitting ? "正在写入…" : `确认导入 ${selectedWritableCount} 条`}
                  </button>
                </div>
              </footer>
            </>
          ) : null}
        </div>
      </dialog>
    </>
  );
}

function isWritableEvent(event: FollowTradeEvent) {
  return Boolean(
    /^[A-Z0-9]{2,}?(?:USDT|USDC|BUSD)$/.test(event.symbol) &&
    Number.isFinite(Date.parse(event.time)) &&
    Number(event.price) > 0 &&
    Number(event.quantity) > 0 &&
    Number(event.quoteQuantity) >= 0 &&
    (event.action.startsWith("open") ||
      event.realizedPnl === null ||
      Number.isFinite(Number(event.realizedPnl))),
  );
}

function formatUtc8Input(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time + UTC_8_OFFSET_MS).toISOString().slice(0, 19);
}

function utc8InputToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  ) - UTC_8_OFFSET_MS;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function nonNegativeNumber(value: string) {
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nullableSignedNumber(value: string) {
  if (value.trim() === "") return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}
