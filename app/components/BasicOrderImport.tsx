"use client";

import { History, ImagePlus, RotateCcw, ShieldCheck, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  createBasicOrderRecord,
  type BasicPositionAction,
  type ParsedBasicOrder,
} from "@/lib/basic-orders.mjs";
import {
  recognizeBasicOrderImages,
  type BasicOrderOcrProgress,
} from "@/app/lib/basic-order-ocr";
import styles from "./ConditionOrderImport.module.css";

export type BasicOrderImportProps = {
  onConfirm: (orders: ParsedBasicOrder[]) => void | Promise<void>;
  disabled?: boolean;
};

type DialogStage = "idle" | "processing" | "review" | "error";

const EMPTY_PROGRESS: BasicOrderOcrProgress = {
  stage: "loading",
  percent: 0,
  currentFile: null,
  fileIndex: 0,
  fileCount: 0,
  message: "准备本地识别",
};

const POSITION_LABELS: Record<BasicPositionAction, string> = {
  openLong: "开多",
  closeLong: "平多",
  openShort: "开空",
  closeShort: "平空",
};

const STATUS_OPTIONS = [
  ["FILLED", "完全成交"],
  ["PARTIALLY_FILLED", "部分成交"],
  ["CANCELED", "已取消"],
  ["EXPIRED", "已过期"],
  ["NEW", "挂单中"],
  ["UNKNOWN", "待校对"],
] as const;

const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function BasicOrderImport({
  onConfirm,
  disabled = false,
}: BasicOrderImportProps) {
  const titleId = useId();
  const descriptionId = useId();
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stage, setStage] = useState<DialogStage>("idle");
  const [progress, setProgress] = useState<BasicOrderOcrProgress>(EMPTY_PROGRESS);
  const [orders, setOrders] = useState<ParsedBasicOrder[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const writableIds = useMemo(() => new Set(
    orders.filter(isWritableOrder).map((order) => order.orderId),
  ), [orders]);
  const selectedWritableCount = [...selectedIds]
    .filter((id) => writableIds.has(id)).length;
  const allWritableSelected = writableIds.size > 0 &&
    [...writableIds].every((id) => selectedIds.has(id));
  const unknownStatusCount = orders.filter((order) => order.status === "UNKNOWN").length;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
  }, []);

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
    setOrders([]);
    setSelectedIds(new Set());
    setErrorMessage("");
    setReviewError("");

    try {
      const recognized = await recognizeBasicOrderImages(
        files,
        setProgress,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setOrders(recognized);
      setSelectedIds(new Set(recognized
        .filter(isWritableOrder)
        .map((order) => order.orderId)));
      setStage("review");
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "本地识别失败，请换一张更清晰的基础单截图重试。",
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

  const updateOrder = (
    orderId: string,
    patch: Partial<ParsedBasicOrder>,
  ) => {
    setOrders((current) => current.map((order) =>
      order.orderId === orderId ? { ...order, ...patch } : order,
    ));
    setReviewError("");
  };

  const toggleSelected = (orderId: string) => {
    if (!writableIds.has(orderId)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const toggleAllWritable = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allWritableSelected) {
        for (const id of writableIds) next.delete(id);
      } else {
        for (const id of writableIds) next.add(id);
      }
      return next;
    });
  };

  const confirmSelected = async () => {
    const selected = orders
      .filter((order) => selectedIds.has(order.orderId) && isWritableOrder(order))
      .map((order) => createBasicOrderRecord(order));
    if (selected.length === 0) {
      setReviewError("请先勾选至少一条字段完整的基础单。");
      return;
    }

    setSubmitting(true);
    setReviewError("");
    try {
      await onConfirm(selected);
      closeDialog();
    } catch (error) {
      setReviewError(
        error instanceof Error
          ? error.message
          : "写入基础单失败，请稍后重试。",
      );
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
        aria-label="选择 Binance U 本位基础单截图"
      />
      <button
        ref={triggerButtonRef}
        type="button"
        className={styles.triggerButton}
        onClick={chooseImages}
        disabled={disabled || stage === "processing"}
      >
        <History size={14} />
        <span>识别基础单</span>
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
              <span className={styles.eyebrow}>LOCAL OCR · BASE ORDERS</span>
              <h2 id={titleId}>OCR 基础单校对</h2>
              <p id={descriptionId}>
                图片仅在本机识别，不会上传；确认后保存订单历史并重建交易复盘。
                成交时间采用委托时间近似。
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeDialog}
              aria-label="关闭基础单校对"
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
              <strong>基础单识别没有完成</strong>
              <span>{errorMessage}</span>
              <button type="button" onClick={chooseReplacementImages}>
                <RotateCcw size={13} />重新选择截图
              </button>
            </div>
          ) : stage === "review" && orders.length === 0 ? (
            <div className={styles.emptyView}>
              <strong>没有识别到基础单</strong>
              <span>请确认截图包含“时间、合约、类型、方向、成交数量、状态”等订单历史列。</span>
              <button type="button" onClick={chooseReplacementImages}>
                <ImagePlus size={13} />换一张截图
              </button>
            </div>
          ) : stage === "review" ? (
            <>
              <div className={styles.reviewSummary}>
                <div>
                  <strong>识别到 {orders.length} 条基础单</strong>
                  <span>
                    {unknownStatusCount > 0
                      ? `${unknownStatusCount} 条状态需重点校对；未成交订单也会保存。`
                      : "字段均已进入校对，未成交订单也会保存。"}
                  </span>
                </div>
                <button type="button" onClick={chooseReplacementImages}>
                  <RotateCcw size={12} />重新识别
                </button>
              </div>

              <div className={styles.tableWrap}>
                <table className={`${styles.table} ${styles.basicTable}`}>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={allWritableSelected}
                          onChange={toggleAllWritable}
                          aria-label="全选可导入基础单"
                        />
                      </th>
                      <th>时间（UTC+8）</th>
                      <th>合约</th>
                      <th>类型</th>
                      <th>方向</th>
                      <th>平均价格</th>
                      <th>委托价格</th>
                      <th>成交数量</th>
                      <th>委托数量</th>
                      <th>只减仓</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => {
                      const writable = writableIds.has(order.orderId);
                      const needsReview = order.status === "UNKNOWN";
                      return (
                        <tr
                          key={order.orderId}
                          className={needsReview ? styles.unmatchedRow : styles.matchedRow}
                        >
                          <td className={styles.checkboxCell} data-label="选择">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(order.orderId)}
                              disabled={!writable}
                              onChange={() => toggleSelected(order.orderId)}
                              aria-label={`选择 ${order.symbol} ${formatUtc8DateTime(order.createdAt)}`}
                            />
                            {needsReview ? (
                              <span className={styles.unmatchedBadge}>待校对</span>
                            ) : null}
                          </td>
                          <td data-label="时间（UTC+8）">
                            <input
                              type="datetime-local"
                              step="1"
                              value={formatUtc8Input(order.createdAt)}
                              onChange={(event) => {
                                const createdAt = utc8InputToIso(event.target.value);
                                if (createdAt) updateOrder(order.orderId, {
                                  createdAt,
                                  updatedAt: createdAt,
                                });
                              }}
                            />
                          </td>
                          <td data-label="合约">
                            <input
                              className={styles.symbolInput}
                              value={order.symbol}
                              onChange={(event) => updateOrder(order.orderId, {
                                symbol: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                              })}
                            />
                          </td>
                          <td data-label="类型">
                            <select
                              value={order.orderType}
                              onChange={(event) => updateOrder(order.orderId, {
                                orderType: event.target.value,
                                ...(event.target.value === "MARKET" ? { limitPrice: null } : {}),
                              })}
                            >
                              <option value="MARKET">MARKET</option>
                              <option value="LIMIT">LIMIT</option>
                            </select>
                          </td>
                          <td data-label="方向">
                            <select
                              value={order.positionAction}
                              onChange={(event) => updateOrder(order.orderId, {
                                positionAction: event.target.value as BasicPositionAction,
                              })}
                            >
                              {Object.entries(POSITION_LABELS).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                          </td>
                          <td data-label="平均价格">
                            <input
                              inputMode="decimal"
                              value={numberInputValue(order.averagePrice)}
                              placeholder="—"
                              onChange={(event) => updateOrder(order.orderId, {
                                averagePrice: nullableInputNumber(event.target.value),
                              })}
                            />
                          </td>
                          <td data-label="委托价格">
                            <input
                              inputMode="decimal"
                              value={numberInputValue(order.limitPrice)}
                              placeholder={order.orderType === "MARKET" ? "市价" : "—"}
                              disabled={order.orderType === "MARKET"}
                              onChange={(event) => updateOrder(order.orderId, {
                                limitPrice: nullableInputNumber(event.target.value),
                              })}
                            />
                          </td>
                          <td data-label="成交数量">
                            <input
                              inputMode="decimal"
                              value={numberInputValue(order.executedQuantity)}
                              onChange={(event) => updateOrder(order.orderId, {
                                executedQuantity: nonNegativeInputNumber(event.target.value),
                              })}
                            />
                          </td>
                          <td data-label="委托数量">
                            <input
                              inputMode="decimal"
                              value={numberInputValue(order.originalQuantity)}
                              onChange={(event) => updateOrder(order.orderId, {
                                originalQuantity: nonNegativeInputNumber(event.target.value),
                              })}
                            />
                          </td>
                          <td data-label="只减仓">
                            <select
                              value={order.reduceOnly ? "yes" : "no"}
                              onChange={(event) => updateOrder(order.orderId, {
                                reduceOnly: event.target.value === "yes",
                              })}
                            >
                              <option value="yes">是</option>
                              <option value="no">否</option>
                            </select>
                          </td>
                          <td data-label="状态">
                            <select
                              value={order.status}
                              onChange={(event) => updateOrder(order.orderId, {
                                status: event.target.value,
                              })}
                            >
                              {STATUS_OPTIONS.map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <footer className={styles.dialogActions}>
                <div>
                  <strong>已选 {selectedWritableCount} 条</strong>
                  <span>成交时间采用委托时间近似；限价单的真实成交时刻可能与截图不同。</span>
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

function isWritableOrder(order: ParsedBasicOrder) {
  return Boolean(
    /^[A-Z0-9]{2,}(?:USDT|USDC|BUSD)$/.test(order.symbol) &&
    Number.isFinite(Date.parse(order.createdAt)) &&
    ["MARKET", "LIMIT"].includes(order.orderType) &&
    Object.prototype.hasOwnProperty.call(POSITION_LABELS, order.positionAction) &&
    Number.isFinite(order.originalQuantity) && order.originalQuantity >= 0 &&
    Number.isFinite(order.executedQuantity) && order.executedQuantity >= 0 &&
    (order.executedQuantity === 0 ||
      (Number(order.averagePrice) > 0 || Number(order.limitPrice) > 0)),
  );
}

function formatUtc8Input(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time + UTC_8_OFFSET_MS).toISOString().slice(0, 19);
}

function formatUtc8DateTime(value: string) {
  return formatUtc8Input(value).replace("T", " ");
}

function utc8InputToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  ) - UTC_8_OFFSET_MS;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

function numberInputValue(value: number | null) {
  return value === null || !Number.isFinite(value) ? "" : String(value);
}

function nullableInputNumber(value: string) {
  if (value.trim() === "") return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeInputNumber(value: string) {
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
