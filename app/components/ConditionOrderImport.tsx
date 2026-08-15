"use client";

import { ImagePlus, RotateCcw, ShieldCheck, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type { NormalizedTrade } from "@/lib/trade.mjs";
import type {
  ConditionalCloseSide,
  ParsedConditionalOrder,
} from "@/lib/conditional-orders.mjs";
import { getTradeCloseTime } from "@/lib/performance.mjs";
import {
  recognizeConditionOrderImages,
  type ConditionOcrProgress,
} from "@/app/lib/condition-order-ocr";
import styles from "./ConditionOrderImport.module.css";

export type ConditionOrderImportTrade = NormalizedTrade & {
  id: string;
  title?: string;
};

export type ConfirmedConditionOrder = ParsedConditionalOrder & {
  matchedTradeId: string;
};

export type ConditionOrderImportProps = {
  trades: readonly ConditionOrderImportTrade[];
  onConfirm: (
    orders: ConfirmedConditionOrder[],
  ) => void | Promise<void>;
  disabled?: boolean;
};

type MatchableTrade = {
  trade: ConditionOrderImportTrade;
  id: string;
  symbol: string;
  closeSide: ConditionalCloseSide;
  entryTime: number;
  exitTime: number;
};

type ConditionDraft = {
  order: ParsedConditionalOrder;
  matchedTradeId: string;
};

type DialogStage = "idle" | "processing" | "review" | "error";

const EMPTY_PROGRESS: ConditionOcrProgress = {
  stage: "loading",
  percent: 0,
  currentFile: null,
  fileIndex: 0,
  fileCount: 0,
  message: "准备本地识别",
};

const UTC_8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function ConditionOrderImport({
  trades,
  onConfirm,
  disabled = false,
}: ConditionOrderImportProps) {
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [stage, setStage] = useState<DialogStage>("idle");
  const [progress, setProgress] = useState<ConditionOcrProgress>(EMPTY_PROGRESS);
  const [drafts, setDrafts] = useState<ConditionDraft[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const matchableTrades = useMemo(
    () => createMatchableTrades(trades),
    [trades],
  );
  const writableIds = useMemo(() => new Set(
    drafts
      .filter((draft) => confirmedOrderForDraft(draft, matchableTrades) !== null)
      .map((draft) => draft.order.id),
  ), [drafts, matchableTrades]);
  const selectedWritableCount = [...selectedIds]
    .filter((id) => writableIds.has(id)).length;
  const allWritableSelected = writableIds.size > 0 &&
    [...writableIds].every((id) => selectedIds.has(id));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) {
      dialog.showModal();
    } else if (!dialogOpen && dialog.open) {
      dialog.close();
    }
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
    setDrafts([]);
    setSelectedIds(new Set());
    setErrorMessage("");
    setReviewError("");

    try {
      const orders = await recognizeConditionOrderImages(
        files,
        setProgress,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDrafts(orders.map((order) => createDraft(order, matchableTrades)));
      setStage("review");
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "本地识别失败，请换一张更清晰的截图重试。",
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

  const updateDraftOrder = (
    id: string,
    patch: Partial<ParsedConditionalOrder>,
    rematch = false,
  ) => {
    setDrafts((current) => current.map((draft) => {
      if (draft.order.id !== id) return draft;
      const order = { ...draft.order, ...patch };
      if (!rematch) return { ...draft, order };
      return createDraft(order, matchableTrades);
    }));
    setSelectedIds((current) => withoutSelection(current, id));
    setReviewError("");
  };

  const updateDraftMatch = (id: string, matchedTradeId: string) => {
    setDrafts((current) => current.map((draft) => {
      if (draft.order.id !== id) return draft;
      if (!matchedTradeId) return { ...draft, matchedTradeId: "" };
      const match = timeCompatibleTrades(draft.order, matchableTrades)
        .find((candidate) => candidate.id === matchedTradeId);
      if (!match) return { ...draft, matchedTradeId: "" };
      return {
        matchedTradeId: match.id,
        order: correctOrderFromTrade(draft.order, match),
      };
    }));
    setSelectedIds((current) => withoutSelection(current, id));
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
    const orders = drafts
      .filter((draft) => selectedIds.has(draft.order.id))
      .map((draft) => confirmedOrderForDraft(draft, matchableTrades))
      .filter((order): order is ConfirmedConditionOrder => order !== null);
    if (orders.length === 0) {
      setReviewError("请先勾选至少一条已匹配交易的条件单。");
      return;
    }

    setSubmitting(true);
    setReviewError("");
    try {
      await onConfirm(orders);
      closeDialog();
    } catch (error) {
      setReviewError(
        error instanceof Error
          ? error.message
          : "写入条件单失败，请稍后重试。",
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
        aria-label="选择条件单截图进行本地识别"
      />
      <button
        ref={triggerButtonRef}
        type="button"
        className={styles.triggerButton}
        onClick={chooseImages}
        disabled={disabled || stage === "processing"}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-busy={stage === "processing"}
      >
        <ImagePlus size={16} aria-hidden="true" />
        <span>{stage === "processing" ? `识别 ${progress.percent}%` : "识别条件单"}</span>
      </button>

      <dialog
        ref={dialogRef}
        id={dialogId}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        <div className={styles.dialogShell} aria-busy={stage === "processing"}>
          <header className={styles.dialogHeader}>
            <div>
              <span className={styles.eyebrow}>LOCAL OCR</span>
              <h2 id={titleId}>OCR 条件单校对</h2>
              <p id={descriptionId}>图片仅在本机识别，不会上传；写入前请逐项校对。</p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeDialog}
              aria-label={stage === "processing" ? "取消识别并关闭" : "关闭条件单校对"}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          {stage === "processing" && (
            <div className={styles.progressView}>
              <div className={styles.localBadge}>
                <ShieldCheck size={16} aria-hidden="true" />
                完全本地识别
              </div>
              <strong>{progress.message}</strong>
              <span>
                {progress.currentFile ?? "正在准备识别资源"}
                {progress.fileCount > 0 && progress.fileIndex > 0
                  ? ` · ${progress.fileIndex}/${progress.fileCount}`
                  : ""}
              </span>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="条件单本地识别进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
                aria-valuetext={`${progress.percent}% · ${progress.message}`}
              >
                <i style={{ width: `${progress.percent}%` }} />
              </div>
              <b aria-live="polite">{progress.percent}%</b>
            </div>
          )}

          {stage === "error" && (
            <div className={styles.emptyView} role="alert">
              <strong>没有完成识别</strong>
              <span>{errorMessage}</span>
              <button type="button" onClick={chooseReplacementImages}>
                <RotateCcw size={15} aria-hidden="true" />重新选择图片
              </button>
            </div>
          )}

          {stage === "review" && (
            <>
              <div className={styles.reviewSummary} aria-live="polite">
                <div>
                  <strong>识别到 {drafts.length} 条条件单</strong>
                  <span>{writableIds.size} 条已匹配，可勾选写入</span>
                </div>
                <button type="button" onClick={chooseReplacementImages}>
                  <ImagePlus size={14} aria-hidden="true" />重新识别
                </button>
              </div>

              {drafts.length === 0 ? (
                <div className={styles.emptyView}>
                  <strong>没有识别到完整条件单</strong>
                  <span>请使用包含时间、币对、平仓方向、类型、触发价、数量和状态的清晰截图。</span>
                  <button type="button" onClick={chooseReplacementImages}>
                    <RotateCcw size={15} aria-hidden="true" />换一张图片
                  </button>
                </div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">
                          <input
                            type="checkbox"
                            checked={allWritableSelected}
                            onChange={toggleAllWritable}
                            disabled={writableIds.size === 0}
                            aria-label="勾选全部已匹配条件单"
                          />
                        </th>
                        <th scope="col">时间</th>
                        <th scope="col">币对</th>
                        <th scope="col">TP / SL</th>
                        <th scope="col">MARKET / LIMIT</th>
                        <th scope="col">触发价</th>
                        <th scope="col">状态</th>
                        <th scope="col">匹配交易</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drafts.map((draft) => {
                        const writable = writableIds.has(draft.order.id);
                        const compatible = timeCompatibleTrades(draft.order, matchableTrades);
                        return (
                          <tr
                            key={draft.order.id}
                            className={writable ? styles.matchedRow : styles.unmatchedRow}
                          >
                            <td className={styles.checkboxCell} data-label="选择">
                              <input
                                type="checkbox"
                                checked={writable && selectedIds.has(draft.order.id)}
                                onChange={() => toggleSelected(draft.order.id)}
                                disabled={!writable}
                                aria-label={`${displaySymbol(draft.order.symbol)} ${kindLabel(draft.order.kind)}，${writable ? "选择写入" : "未匹配，不可写入"}`}
                              />
                            </td>
                            <td data-label="时间">
                              <input
                                type="datetime-local"
                                step="1"
                                value={isoToUtc8Input(draft.order.createdTime)}
                                onChange={(event) => {
                                  const createdTime = utc8InputToIso(event.target.value);
                                  if (createdTime) {
                                    updateDraftOrder(draft.order.id, { createdTime }, true);
                                  }
                                }}
                                aria-label={`${displaySymbol(draft.order.symbol)} 条件单时间（UTC+8）`}
                              />
                            </td>
                            <td data-label="币对">
                              <input
                                className={styles.symbolInput}
                                value={draft.order.symbol}
                                onChange={(event) => updateDraftOrder(
                                  draft.order.id,
                                  { symbol: normalizeSymbol(event.target.value) },
                                  true,
                                )}
                                aria-label="条件单币对"
                              />
                            </td>
                            <td data-label="TP / SL">
                              <select
                                value={draft.order.kind}
                                onChange={(event) => updateDraftOrder(draft.order.id, {
                                  kind: event.target.value as ParsedConditionalOrder["kind"],
                                })}
                                aria-label={`${displaySymbol(draft.order.symbol)} 条件单类型`}
                              >
                                <option value="takeProfit">TP 止盈</option>
                                <option value="stopLoss">SL 止损</option>
                              </select>
                            </td>
                            <td data-label="MARKET / LIMIT">
                              <select
                                value={draft.order.executionType}
                                onChange={(event) => updateDraftOrder(draft.order.id, {
                                  executionType: event.target.value as ParsedConditionalOrder["executionType"],
                                })}
                                aria-label={`${displaySymbol(draft.order.symbol)} 执行类型`}
                              >
                                <option value="market">MARKET</option>
                                <option value="limit">LIMIT</option>
                              </select>
                            </td>
                            <td data-label="触发价">
                              <div className={styles.priceField}>
                                <span>{draft.order.comparator}</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={draft.order.triggerPrice || ""}
                                  onChange={(event) => updateDraftOrder(draft.order.id, {
                                    triggerPrice: Number(event.target.value),
                                  })}
                                  aria-label={`${displaySymbol(draft.order.symbol)} 触发价`}
                                />
                              </div>
                            </td>
                            <td data-label="状态">
                              <select
                                value={draft.order.status}
                                onChange={(event) => updateDraftOrder(draft.order.id, {
                                  status: event.target.value as ParsedConditionalOrder["status"],
                                })}
                                aria-label={`${displaySymbol(draft.order.symbol)} 条件单状态`}
                              >
                                <option value="filled">已触发</option>
                                <option value="cancelled">已取消</option>
                                <option value="expired">已过期</option>
                                <option value="unknown">未识别</option>
                              </select>
                            </td>
                            <td className={styles.matchCell} data-label="匹配交易">
                              <span className={writable ? styles.matchBadge : styles.unmatchedBadge}>
                                {writable ? "已匹配" : "未匹配，不可写入"}
                              </span>
                              <select
                                value={compatible.some((item) => item.id === draft.matchedTradeId)
                                  ? draft.matchedTradeId
                                  : ""}
                                onChange={(event) => updateDraftMatch(
                                  draft.order.id,
                                  event.target.value,
                                )}
                                aria-label={`${displaySymbol(draft.order.symbol)} 匹配交易`}
                              >
                                <option value="">未匹配</option>
                                {compatible.map((candidate) => (
                                  <option key={candidate.id} value={candidate.id}>
                                    {tradeOptionLabel(candidate)}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <footer className={styles.dialogActions}>
                <div>
                  <strong>已选 {selectedWritableCount} 条</strong>
                  <span>未匹配记录不会写入复盘</span>
                  {reviewError && <em role="alert">{reviewError}</em>}
                </div>
                <div>
                  <button type="button" className={styles.cancelButton} onClick={closeDialog}>
                    取消
                  </button>
                  <button
                    type="button"
                    className={styles.confirmButton}
                    onClick={() => void confirmSelected()}
                    disabled={selectedWritableCount === 0 || submitting}
                  >
                    {submitting ? "正在写入…" : `确认写入 ${selectedWritableCount} 条`}
                  </button>
                </div>
              </footer>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}

function createMatchableTrades(
  trades: readonly ConditionOrderImportTrade[],
): MatchableTrade[] {
  return trades.flatMap((trade) => {
    if (!trade.id.startsWith("import-")) return [];
    const entryTime = Date.parse(String(trade.entryTime ?? ""));
    const exitTime = getTradeCloseTime(trade);
    const closeSide = closeSideForTrade(trade.side);
    const symbol = normalizeSymbol(trade.symbol);
    if (
      !Number.isFinite(entryTime) ||
      exitTime === null ||
      exitTime < entryTime ||
      !closeSide ||
      !symbol
    ) {
      return [];
    }
    return [{ trade, id: trade.id, symbol, closeSide, entryTime, exitTime }];
  });
}

function createDraft(
  order: ParsedConditionalOrder,
  trades: readonly MatchableTrade[],
): ConditionDraft {
  const exactMatches = exactMatchingTrades(order, trades);
  return {
    order,
    matchedTradeId: exactMatches.length === 1 ? exactMatches[0].id : "",
  };
}

function exactMatchingTrades(
  order: ParsedConditionalOrder,
  trades: readonly MatchableTrade[],
) {
  const symbol = normalizeSymbol(order.symbol);
  return timeCompatibleTrades(order, trades).filter((candidate) =>
    candidate.symbol === symbol && candidate.closeSide === order.closeSide,
  );
}

function timeCompatibleTrades(
  order: ParsedConditionalOrder,
  trades: readonly MatchableTrade[],
) {
  const createdTime = Date.parse(order.createdTime);
  if (!Number.isFinite(createdTime)) return [];
  return trades.filter((candidate) =>
    createdTime >= candidate.entryTime && createdTime <= candidate.exitTime,
  );
}

function confirmedOrderForDraft(
  draft: ConditionDraft,
  trades: readonly MatchableTrade[],
): ConfirmedConditionOrder | null {
  if (!draft.matchedTradeId || !Number.isFinite(draft.order.triggerPrice) || draft.order.triggerPrice <= 0) {
    return null;
  }
  const match = timeCompatibleTrades(draft.order, trades)
    .find((candidate) => candidate.id === draft.matchedTradeId);
  if (!match) return null;
  return {
    ...correctOrderFromTrade(draft.order, match),
    matchedTradeId: match.id,
  };
}

function correctOrderFromTrade(
  order: ParsedConditionalOrder,
  trade: MatchableTrade,
): ParsedConditionalOrder {
  return {
    ...order,
    symbol: trade.symbol,
    closeSide: trade.closeSide,
    comparator: comparatorFor(trade.closeSide, order.kind),
    asset: trade.symbol.replace(/(?:USDT|USDC|BUSD)$/i, ""),
  };
}

function comparatorFor(
  closeSide: ConditionalCloseSide,
  kind: ParsedConditionalOrder["kind"],
): ParsedConditionalOrder["comparator"] {
  if (closeSide === "closeLong") {
    return kind === "takeProfit" ? ">=" : "<=";
  }
  return kind === "takeProfit" ? "<=" : ">=";
}

function closeSideForTrade(side: string): ConditionalCloseSide | null {
  if (side === "long") return "closeLong";
  if (side === "short") return "closeShort";
  return null;
}

function normalizeSymbol(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function displaySymbol(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  if (normalized.endsWith("USDT")) return `${normalized.slice(0, -4)}/USDT`;
  if (normalized.endsWith("USDC")) return `${normalized.slice(0, -4)}/USDC`;
  return normalized;
}

function kindLabel(kind: ParsedConditionalOrder["kind"]) {
  return kind === "takeProfit" ? "止盈" : "止损";
}

function tradeOptionLabel(candidate: MatchableTrade) {
  const side = candidate.closeSide === "closeLong" ? "多仓" : "空仓";
  return `${displaySymbol(candidate.symbol)} · ${side} · ${formatUtc8DateTime(candidate.entryTime)}`;
}

function formatUtc8DateTime(value: string | number) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "时间无效";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(time));
}

function isoToUtc8Input(value: string) {
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

function withoutSelection(current: Set<string>, id: string) {
  if (!current.has(id)) return current;
  const next = new Set(current);
  next.delete(id);
  return next;
}
