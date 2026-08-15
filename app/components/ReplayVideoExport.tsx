"use client";

import {
  Download,
  Film,
  ShieldCheck,
  Square,
  Video,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  VIDEO_EXPORT_DEFAULTS,
  createVideoExportPlan,
  normalizeVideoExportConfig,
  type VideoExportConfig,
  type VideoExportFramePlan,
} from "@/lib/video-export.mjs";
import { fetchVideoExportCandles } from "@/lib/video-market.mjs";
import { fetchVideoOpenInterest } from "@/lib/video-open-interest.mjs";
import {
  REPLAY_VIDEO_HEIGHT,
  REPLAY_VIDEO_WIDTH,
  renderReplayVideoFrame,
  type ReplayVideoCandle,
  type ReplayVideoIndicatorVisibility,
  type ReplayVideoOpenInterestPoint,
  type ReplayVideoSecondaryTimeframes,
  type ReplayVideoTimeframe,
  type ReplayVideoTrade,
  type ReplayVideoVolumeColoringConfig,
} from "../lib/replay-video-renderer";
import styles from "./ReplayVideoExport.module.css";

type VideoTimeFrame = "5m" | "15m" | "1h" | "4h" | "1d";
type ExportPhase =
  | "idle"
  | "preparing"
  | "recording"
  | "saving"
  | "completed"
  | "cancelled"
  | "error";

type ExportStatus = {
  phase: ExportPhase;
  percent: number;
  message: string;
  fileName?: string;
};

type RecorderFormat = {
  mimeType: string;
  extension: "mp4" | "webm";
  label: "MP4" | "WebM";
};

type VideoSink = {
  fileName: string;
  memoryBacked: boolean;
  write(chunk: Blob): Promise<void>;
  complete(): Promise<void>;
  cancel(): Promise<void>;
};

type ReplayVideoExportTrade = ReplayVideoTrade & {
  marketDataSource?: "binance-futures";
  openPosition?: object | null;
  feesKnown?: boolean;
};

type ReplayVideoExportProps = {
  trade: ReplayVideoExportTrade;
  frame: VideoTimeFrame;
  candles: ReplayVideoCandle[];
  openInterest: ReplayVideoOpenInterestPoint[];
  source: string;
  entryIndex: number;
  indicatorVisibility: ReplayVideoIndicatorVisibility;
  volumeColoringConfig: ReplayVideoVolumeColoringConfig;
  disabled?: boolean;
  onExportStart?: () => void;
};

const FRAME_MS: Record<VideoTimeFrame, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const VIDEO_BASE_FRAME = "5m";
const VIDEO_BASE_INTERVAL_MS = FRAME_MS[VIDEO_BASE_FRAME];
const MULTI_TIMEFRAME_HISTORY_DAYS = 31;
const MULTI_TIMEFRAME_HISTORY_MS =
  MULTI_TIMEFRAME_HISTORY_DAYS * FRAME_MS["1d"];
const VIDEO_CHART_CONTEXT_CANDLES = 80;
const SPEED_OPTIONS = [0.5, 1, 2, 4] as const;
const MAX_CONTEXT_CANDLES = 500;
const MAX_MEMORY_VIDEO_DURATION_MS = 5 * 60_000;
const EMA_WARMUP_CANDLES = 280;
const VIDEO_TIMEFRAME_OPTIONS: ReadonlyArray<{
  value: ReplayVideoTimeframe;
  label: string;
}> = [
  { value: "5m", label: "5 分钟" },
  { value: "15m", label: "15 分钟" },
  { value: "1H", label: "1 小时" },
  { value: "4H", label: "4 小时" },
  { value: "1D", label: "1 天" },
];
const DEFAULT_VIDEO_SECONDARY_TIMEFRAMES: ReplayVideoSecondaryTimeframes = [
  "1H",
  "4H",
  "1D",
];

const INITIAL_STATUS: ExportStatus = {
  phase: "idle",
  percent: 0,
  message: "",
};

export function ReplayVideoExport({
  trade,
  frame,
  candles,
  openInterest,
  source,
  entryIndex,
  indicatorVisibility,
  volumeColoringConfig,
  disabled = false,
  onExportStart,
}: ReplayVideoExportProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cancelRequestedRef = useRef(false);
  const activeRecorderRef = useRef<MediaRecorder | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const activeSinkRef = useRef<VideoSink | null>(null);
  const activeFetchControllerRef = useRef<AbortController | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [preEntryCandles, setPreEntryCandles] = useState(
    String(VIDEO_EXPORT_DEFAULTS.preEntryCandles),
  );
  const [postExitCandles, setPostExitCandles] = useState(
    String(VIDEO_EXPORT_DEFAULTS.postExitCandles),
  );
  const [playbackSpeed, setPlaybackSpeed] = useState(
    String(VIDEO_EXPORT_DEFAULTS.playbackSpeed),
  );
  const [mainTimeframe, setMainTimeframe] = useState<ReplayVideoTimeframe>("5m");
  const [secondaryTimeframes, setSecondaryTimeframes] =
    useState<ReplayVideoSecondaryTimeframes>(DEFAULT_VIDEO_SECONDARY_TIMEFRAMES);
  const [status, setStatus] = useState<ExportStatus>(INITIAL_STATUS);

  const finalExitTimeMs = useMemo(() => getFinalExitTimeMs(trade), [trade]);
  const closedTrade = finalExitTimeMs !== null && !trade.openPosition;
  const exporting = status.phase === "preparing" ||
    status.phase === "recording" ||
    status.phase === "saving";

  const normalizedPreviewConfig = useMemo(() => {
    try {
      const config = normalizeVideoExportConfig({
        preEntryCandles,
        postExitCandles,
        playbackSpeed,
      });
      if (
        config.preEntryCandles > MAX_CONTEXT_CANDLES ||
        config.postExitCandles > MAX_CONTEXT_CANDLES
      ) {
        return null;
      }
      return config;
    } catch {
      return null;
    }
  }, [playbackSpeed, postExitCandles, preEntryCandles]);

  const estimatedDurationMs = useMemo(() => {
    if (!normalizedPreviewConfig || finalExitTimeMs === null) return null;
    const entryTimeMs = parseTime(trade.entryTime);
    if (entryTimeMs === null) return null;
    const tradeCandles = Math.max(
      1,
      Math.floor((finalExitTimeMs - entryTimeMs) / VIDEO_BASE_INTERVAL_MS) + 1,
    );
    const candleCount = normalizedPreviewConfig.preEntryCandles +
      tradeCandles +
      normalizedPreviewConfig.postExitCandles;
    return candleCount *
      normalizedPreviewConfig.framesPerCandle *
      (100 / normalizedPreviewConfig.playbackSpeed);
  }, [finalExitTimeMs, normalizedPreviewConfig, trade.entryTime]);

  const updateSecondaryTimeframe = useCallback((
    index: number,
    value: ReplayVideoTimeframe,
  ) => {
    setSecondaryTimeframes((current) => {
      const next: [
        ReplayVideoTimeframe,
        ReplayVideoTimeframe,
        ReplayVideoTimeframe,
      ] = [...current];
      next[index] = value;
      return next;
    });
  }, []);

  const closeDialog = useCallback(() => {
    if (exporting) return;
    dialogRef.current?.close();
    setIsOpen(false);
    if (status.phase !== "completed") setStatus(INITIAL_STATUS);
  }, [exporting, status.phase]);

  const openDialog = useCallback(() => {
    setStatus(INITIAL_STATUS);
    setIsOpen(true);
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    if (!isOpen || exporting || !canvasRef.current) return;
    if (frame !== VIDEO_BASE_FRAME || candles.length === 0) {
      drawPreviewPlaceholder(
        canvasRef.current,
        `导出时将准备 ${mainTimeframe} 主图与 ${secondaryTimeframes.join(" / ")} 副图`,
      );
      return;
    }
    const rangeStart = Math.max(0, entryIndex - Number(preEntryCandles || 0));
    const rangeEnd = Math.max(rangeStart, candles.length - 1);
    try {
      renderReplayVideoFrame(canvasRef.current, {
        trade,
        candles,
        openInterest,
        candleIndex: rangeStart,
        phase: 1 / VIDEO_EXPORT_DEFAULTS.framesPerCandle,
        entryIndex,
        range: { startIndex: rangeStart, endIndex: rangeEnd },
        timeframe: mainTimeframe,
        secondaryTimeframes,
        speed: Number(playbackSpeed) || 1,
        source,
        indicatorVisibility,
        volumeColoringConfig,
      });
    } catch {
      drawPreviewPlaceholder(canvasRef.current, "等待准备完整视频行情");
    }
  }, [
    candles,
    entryIndex,
    exporting,
    frame,
    indicatorVisibility,
    isOpen,
    mainTimeframe,
    openInterest,
    playbackSpeed,
    preEntryCandles,
    source,
    secondaryTimeframes,
    trade,
    volumeColoringConfig,
  ]);

  useEffect(() => () => {
    cancelRequestedRef.current = true;
    activeFetchControllerRef.current?.abort();
    if (activeRecorderRef.current?.state !== "inactive") {
      activeRecorderRef.current?.stop();
    }
    activeStreamRef.current?.getTracks().forEach((track) => track.stop());
    void activeSinkRef.current?.cancel().catch(() => undefined);
  }, []);

  const cancelExport = useCallback(() => {
    cancelRequestedRef.current = true;
    activeFetchControllerRef.current?.abort();
    setStatus((current) => ({
      ...current,
      phase: "cancelled",
      message: "正在取消并清理未完成的视频…",
    }));
    if (activeRecorderRef.current?.state !== "inactive") {
      activeRecorderRef.current?.stop();
    }
  }, []);

  const startExport = useCallback(async () => {
    if (!canvasRef.current || exporting) return;
    let sink: VideoSink | null = null;
    let stream: MediaStream | null = null;
    try {
      const config = validateExportConfig({
        preEntryCandles,
        postExitCandles,
        playbackSpeed,
      });
      if (!closedTrade) {
        throw new Error("这笔交易尚未完全平仓，暂时无法确定视频结束位置");
      }
      const format = selectRecorderFormat();
      const suggestedName = buildVideoFileName(
        trade,
        mainTimeframe,
        format.extension,
      );
      sink = await createVideoSink({ format, suggestedName });
      if (!sink) return;
      activeSinkRef.current = sink;
      cancelRequestedRef.current = false;
      onExportStart?.();
      setStatus({
        phase: "preparing",
        percent: 2,
        message: `正在准备 ${mainTimeframe} 主图与 ${secondaryTimeframes.join(" / ")} 副图…`,
        fileName: sink.fileName,
      });

      const fetchController = new AbortController();
      activeFetchControllerRef.current = fetchController;
      const prepared = await prepareVideoData({
        trade,
        currentFrame: frame,
        currentCandles: candles,
        currentSource: source,
        config,
        signal: fetchController.signal,
      });
      activeFetchControllerRef.current = null;
      if (cancelRequestedRef.current) throw abortError();
      if (sink.memoryBacked && prepared.plan.totalDurationMs > MAX_MEMORY_VIDEO_DURATION_MS) {
        throw new RangeError("当前网页环境只能直接下载 5 分钟以内的视频，请使用桌面版或提高播放速度");
      }
      setStatus({
        phase: "preparing",
        percent: 4,
        message: "正在校验视频范围内的 OI 与指标数据…",
        fileName: sink.fileName,
      });
      const preparedIndicators = await prepareVideoIndicators({
        trade,
        candles: prepared.candles,
        plan: prepared.plan,
        currentOpenInterest: frame === VIDEO_BASE_FRAME ? openInterest : [],
        indicatorVisibility,
        signal: fetchController.signal,
      });
      if (cancelRequestedRef.current) throw abortError();

      const captureStream = canvasRef.current.captureStream;
      if (typeof captureStream !== "function") {
        throw new Error("当前环境不支持 Canvas 视频录制");
      }
      stream = captureStream.call(canvasRef.current, 30);
      activeStreamRef.current = stream;
      const recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: 10_000_000,
      });
      activeRecorderRef.current = recorder;

      await recordPlan({
        recorder,
        sink,
        canvas: canvasRef.current,
        plan: prepared.plan,
        trade,
        candles: prepared.candles,
        openInterest: preparedIndicators.openInterest,
        speed: config.playbackSpeed,
        source: prepared.source,
        indicatorVisibility: preparedIndicators.indicatorVisibility,
        volumeColoringConfig,
        mainTimeframe,
        secondaryTimeframes,
        cancelled: () => cancelRequestedRef.current,
        onProgress: (percent) => setStatus({
          phase: "recording",
          percent,
          message: `正在录制 1080P ${format.label} · ${formatDuration(prepared.plan.totalDurationMs)}${preparedIndicators.notice ? ` · ${preparedIndicators.notice}` : ""}`,
          fileName: sink?.fileName,
        }),
      });

      if (cancelRequestedRef.current) throw abortError();
      setStatus({
        phase: "saving",
        percent: 98,
        message: "正在写入最后一段视频…",
        fileName: sink.fileName,
      });
      await sink.complete();
      activeSinkRef.current = null;
      setStatus({
        phase: "completed",
        percent: 100,
        message: preparedIndicators.notice
          ? `1080P 复盘视频已经导出 · ${preparedIndicators.notice}`
          : "1080P 复盘视频已经导出",
        fileName: sink.fileName,
      });
    } catch (error) {
      await sink?.cancel().catch(() => undefined);
      activeSinkRef.current = null;
      if (isAbortError(error) || cancelRequestedRef.current) {
        setStatus({
          phase: "cancelled",
          percent: 0,
          message: "导出已取消，未完成文件已清理",
        });
      } else {
        setStatus({
          phase: "error",
          percent: 0,
          message: error instanceof Error ? error.message : "视频导出失败，请重试",
        });
      }
    } finally {
      if (activeRecorderRef.current?.state !== "inactive") {
        activeRecorderRef.current?.stop();
      }
      stream?.getTracks().forEach((track) => track.stop());
      activeRecorderRef.current = null;
      activeStreamRef.current = null;
      activeFetchControllerRef.current = null;
      cancelRequestedRef.current = false;
    }
  }, [
    candles,
    closedTrade,
    exporting,
    frame,
    indicatorVisibility,
    mainTimeframe,
    onExportStart,
    openInterest,
    playbackSpeed,
    postExitCandles,
    preEntryCandles,
    source,
    secondaryTimeframes,
    trade,
    volumeColoringConfig,
  ]);

  return (
    <>
      <button
        type="button"
        className={styles.triggerButton}
        onClick={openDialog}
        disabled={disabled || !closedTrade}
        title={closedTrade ? "导出当前交易的 1080P 回放视频" : "交易完全平仓后才能导出视频"}
      >
        <Video size={13} />导出视频
      </button>

      <dialog
        ref={dialogRef}
        className={styles.dialog}
        onCancel={(event) => {
          if (exporting) event.preventDefault();
        }}
        onClose={() => setIsOpen(false)}
      >
        <div className={styles.dialogShell}>
          <header className={styles.dialogHeader}>
            <div>
              <span className={styles.eyebrow}>LOCAL VIDEO EXPORT</span>
              <h2>导出 1080P 交易复盘</h2>
              <p>{trade.symbol} · {mainTimeframe} 主图 · {secondaryTimeframes.join(" / ")} 副图 · 保留交易标记</p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeDialog}
              disabled={exporting}
              aria-label="关闭视频导出"
            >
              <X size={17} />
            </button>
          </header>

          <div className={styles.dialogBody}>
            <aside className={styles.settingsPanel}>
              <div className={styles.resolutionBadge}>
                <Film size={15} />
                <div><strong>1920 × 1080</strong><span>固定 1080P · 30 FPS</span></div>
              </div>

              <div className={styles.fieldGrid}>
                <label>
                  <span>入场前 5m K 线</span>
                  <input
                    type="number"
                    min="0"
                    max={MAX_CONTEXT_CANDLES}
                    step="1"
                    value={preEntryCandles}
                    onChange={(event) => setPreEntryCandles(event.target.value)}
                    disabled={exporting}
                  />
                  <small>默认 10 根</small>
                </label>
                <label>
                  <span>平仓后 5m K 线</span>
                  <input
                    type="number"
                    min="0"
                    max={MAX_CONTEXT_CANDLES}
                    step="1"
                    value={postExitCandles}
                    onChange={(event) => setPostExitCandles(event.target.value)}
                    disabled={exporting}
                  />
                  <small>默认 100 根</small>
                </label>
              </div>

              <div className={styles.timeframeField}>
                <span>视频 K 线布局</span>
                <label>
                  <span>主图</span>
                  <select
                    aria-label="视频主图时间框架"
                    value={mainTimeframe}
                    onChange={(event) => setMainTimeframe(
                      event.currentTarget.value as ReplayVideoTimeframe,
                    )}
                    disabled={exporting}
                  >
                    {VIDEO_TIMEFRAME_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className={styles.secondaryTimeframeGrid}>
                  {secondaryTimeframes.map((timeframe, index) => (
                    <label key={index}>
                      <span>副图 {index + 1}</span>
                      <select
                        aria-label={`视频副图 ${index + 1} 时间框架`}
                        value={timeframe}
                        onChange={(event) => updateSecondaryTimeframe(
                          index,
                          event.currentTarget.value as ReplayVideoTimeframe,
                        )}
                        disabled={exporting}
                      >
                        {VIDEO_TIMEFRAME_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              <div className={styles.speedField}>
                <span>5m K 线播放速度</span>
                <div role="group" aria-label="视频 5m K 线播放速度">
                  {SPEED_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={Number(playbackSpeed) === value ? styles.active : ""}
                      onClick={() => setPlaybackSpeed(String(value))}
                      disabled={exporting}
                      aria-pressed={Number(playbackSpeed) === value}
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              </div>

              <dl className={styles.exportSummary}>
                <div><dt>时间框架</dt><dd>{mainTimeframe} 主图 · {secondaryTimeframes.join(" / ")}</dd></div>
                <div><dt>预计时长</dt><dd>{estimatedDurationMs === null ? "—" : formatDuration(estimatedDurationMs)}</dd></div>
                <div><dt>视频内容</dt><dd>K线染色 / 指标 / TP·SL / 交易标记</dd></div>
                <div><dt>视频布局</dt><dd>无右侧详情栏</dd></div>
                <div><dt>编码格式</dt><dd>优先 MP4，不支持时 WebM</dd></div>
              </dl>

              <div className={styles.localNotice}>
                <ShieldCheck size={15} />
                <span>行情和视频只在本机处理，不会上传。</span>
              </div>
            </aside>

            <section className={styles.previewPanel} aria-label="1080P 视频预览与导出进度">
              <div className={styles.previewHeader}>
                <div><i /><span>1080P VIDEO PREVIEW</span></div>
                <strong>{status.phase === "recording" ? `${Math.round(status.percent)}%` : "16:9"}</strong>
              </div>
              <div className={styles.canvasWrap}>
                <canvas
                  ref={canvasRef}
                  width={REPLAY_VIDEO_WIDTH}
                  height={REPLAY_VIDEO_HEIGHT}
                  aria-label="交易复盘视频画面预览"
                />
              </div>

              {status.phase !== "idle" && (
                <div className={`${styles.exportStatus} ${styles[status.phase]}`} role="status" aria-live="polite">
                  <div>
                    <strong>{status.message}</strong>
                    {status.fileName && <span>{status.fileName}</span>}
                  </div>
                  <div className={styles.progressTrack}>
                    <i style={{ width: `${Math.max(0, Math.min(status.percent, 100))}%` }} />
                  </div>
                </div>
              )}
            </section>
          </div>

          <footer className={styles.dialogFooter}>
            <span>导出期间请保持应用运行；速度越快，视频时长越短。</span>
            <div>
              {exporting ? (
                <button type="button" className={styles.cancelButton} onClick={cancelExport}>
                  <Square size={13} />取消导出
                </button>
              ) : (
                <button type="button" className={styles.secondaryButton} onClick={closeDialog}>
                  关闭
                </button>
              )}
              <button
                type="button"
                className={styles.exportButton}
                onClick={() => void startExport()}
                disabled={exporting || !normalizedPreviewConfig}
              >
                <Download size={15} />
                {status.phase === "completed" ? "再次导出" : "选择位置并导出"}
              </button>
            </div>
          </footer>
        </div>
      </dialog>
    </>
  );
}

function validateExportConfig(input: {
  preEntryCandles: string;
  postExitCandles: string;
  playbackSpeed: string;
}): VideoExportConfig {
  const config = normalizeVideoExportConfig(input);
  if (
    config.preEntryCandles > MAX_CONTEXT_CANDLES ||
    config.postExitCandles > MAX_CONTEXT_CANDLES
  ) {
    throw new RangeError(`入场前和平仓后 K 线最多各填写 ${MAX_CONTEXT_CANDLES} 根`);
  }
  if (!SPEED_OPTIONS.includes(config.playbackSpeed as typeof SPEED_OPTIONS[number])) {
    throw new RangeError("视频播放速度必须选择 0.5×、1×、2× 或 4×");
  }
  return config;
}

async function prepareVideoData({
  trade,
  currentFrame,
  currentCandles,
  currentSource,
  config,
  signal,
}: {
  trade: ReplayVideoExportTrade;
  currentFrame: VideoTimeFrame;
  currentCandles: ReplayVideoCandle[];
  currentSource: string;
  config: VideoExportConfig;
  signal: AbortSignal;
}) {
  const entryTimeMs = parseTime(trade.entryTime);
  const finalExitTimeMs = getFinalExitTimeMs(trade);
  if (entryTimeMs === null || finalExitTimeMs === null) {
    throw new Error("交易缺少有效的入场或最终平仓时间");
  }
  const historyStartTime = alignToVideoCandle(
    entryTimeMs - MULTI_TIMEFRAME_HISTORY_MS,
  );

  let currentDataError: unknown = null;
  if (currentFrame === VIDEO_BASE_FRAME) {
    try {
      const plan = createVideoExportPlan(trade, currentCandles, config);
      if (!hasFiveMinuteHistoryCoverage(currentCandles, historyStartTime)) {
        throw new RangeError(
          `当前 5m 行情不足 ${MULTI_TIMEFRAME_HISTORY_DAYS} 天，无法生成 1D 上下文`,
        );
      }
      return { plan, candles: currentCandles, source: currentSource };
    } catch (error) {
      currentDataError = error;
    }
  } else {
    currentDataError = new RangeError("当前界面行情不是 5m，视频需要独立准备 5m 数据");
  }

  if (currentSource === "演示行情") {
    throw new Error(
      `${currentDataError instanceof Error ? currentDataError.message : "当前 5m 行情范围不足"}；演示行情不会联网补齐视频数据`,
    );
  }

  const indicatorWarmupStartTime = alignToVideoCandle(
    entryTimeMs - VIDEO_BASE_INTERVAL_MS * (
      EMA_WARMUP_CANDLES + config.preEntryCandles + 2
    ),
  );
  const startTime = Math.max(
    1,
    Math.min(historyStartTime, indicatorWarmupStartTime),
  );
  const endTime = Math.ceil(
    finalExitTimeMs +
      VIDEO_BASE_INTERVAL_MS * (config.postExitCandles + 2),
  );
  const result = await fetchVideoExportCandles({
    fetchImpl: window.fetch.bind(window),
    symbol: trade.symbol,
    interval: VIDEO_BASE_FRAME,
    market: trade.marketDataSource === "binance-futures"
      ? "binance-futures"
      : "binance",
    startTime,
    endTime,
    signal,
  });
  const plan = createVideoExportPlan(trade, result.candles, config);
  return { plan, candles: result.candles, source: result.source };
}

async function prepareVideoIndicators({
  trade,
  candles,
  plan,
  currentOpenInterest,
  indicatorVisibility,
  signal,
}: {
  trade: ReplayVideoExportTrade;
  candles: ReplayVideoCandle[];
  plan: VideoExportFramePlan;
  currentOpenInterest: ReplayVideoOpenInterestPoint[];
  indicatorVisibility: ReplayVideoIndicatorVisibility;
  signal: AbortSignal;
}) {
  if (
    !indicatorVisibility.openInterest ||
    trade.marketDataSource !== "binance-futures"
  ) {
    return {
      openInterest: currentOpenInterest,
      indicatorVisibility,
      notice: "",
    };
  }

  const contextStartIndex = Math.max(
    0,
    plan.range.startIndex - (VIDEO_CHART_CONTEXT_CANDLES - 1),
  );
  const firstCandle = candles[contextStartIndex];
  const finalCandle = candles[plan.range.endIndex];
  const startTime = Math.round(firstCandle.time * 1000);
  const finalOpenTime = Math.round(finalCandle.time * 1000);
  const endTime = Number.isFinite(finalCandle.closeTime)
    ? Math.round(finalCandle.closeTime as number)
    : finalOpenTime + VIDEO_BASE_INTERVAL_MS - 1;
  if (
    hasOpenInterestCoverage(
      currentOpenInterest,
      startTime,
      finalOpenTime,
      VIDEO_BASE_INTERVAL_MS,
    )
  ) {
    return {
      openInterest: currentOpenInterest,
      indicatorVisibility,
      notice: "",
    };
  }

  try {
    const result = await fetchVideoOpenInterest(
      {
        symbol: trade.symbol,
        period: VIDEO_BASE_FRAME,
        startTime,
        endTime,
        signal,
      },
      window.fetch.bind(window),
    );
    if (
      !hasOpenInterestCoverage(
        result.points,
        startTime,
        finalOpenTime,
        VIDEO_BASE_INTERVAL_MS,
      )
    ) {
      throw new RangeError("历史 OI 没有覆盖完整视频区间");
    }
    return {
      openInterest: result.points,
      indicatorVisibility,
      notice: "",
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      openInterest: [],
      indicatorVisibility: {
        ...indicatorVisibility,
        openInterest: false,
      },
      notice: "历史 OI 不完整，视频中已隐藏 OI",
    };
  }
}

function hasOpenInterestCoverage(
  points: ReplayVideoOpenInterestPoint[],
  startTime: number,
  finalOpenTime: number,
  intervalMs: number,
) {
  const valid = points
    .filter((point) =>
      Number.isFinite(point.time) &&
      Number.isFinite(point.openInterest),
    )
    .sort((left, right) => left.time - right.time);
  if (valid.length === 0) return false;
  const firstTime = valid[0].time * 1000;
  const finalTime = valid.at(-1)!.time * 1000;
  return firstTime <= startTime + intervalMs && finalTime >= finalOpenTime;
}

function alignToVideoCandle(timeMs: number) {
  return Math.floor(timeMs / VIDEO_BASE_INTERVAL_MS) *
    VIDEO_BASE_INTERVAL_MS;
}

function hasFiveMinuteHistoryCoverage(
  candles: ReplayVideoCandle[],
  requiredStartTimeMs: number,
) {
  if (candles.length === 0) return false;
  const firstOpenTimeMs = Number(candles[0].time) * 1000;
  if (
    !Number.isFinite(firstOpenTimeMs) ||
    firstOpenTimeMs > requiredStartTimeMs
  ) {
    return false;
  }

  for (let index = 1; index < candles.length; index += 1) {
    const previousOpenTimeMs = Number(candles[index - 1].time) * 1000;
    const openTimeMs = Number(candles[index].time) * 1000;
    if (
      !Number.isFinite(previousOpenTimeMs) ||
      !Number.isFinite(openTimeMs) ||
      openTimeMs - previousOpenTimeMs !== VIDEO_BASE_INTERVAL_MS
    ) {
      return false;
    }
  }
  return true;
}

async function recordPlan({
  recorder,
  sink,
  canvas,
  plan,
  trade,
  candles,
  openInterest,
  speed,
  source,
  indicatorVisibility,
  volumeColoringConfig,
  mainTimeframe,
  secondaryTimeframes,
  cancelled,
  onProgress,
}: {
  recorder: MediaRecorder;
  sink: VideoSink;
  canvas: HTMLCanvasElement;
  plan: VideoExportFramePlan;
  trade: ReplayVideoExportTrade;
  candles: ReplayVideoCandle[];
  openInterest: ReplayVideoOpenInterestPoint[];
  speed: number;
  source: string;
  indicatorVisibility: ReplayVideoIndicatorVisibility;
  volumeColoringConfig: ReplayVideoVolumeColoringConfig;
  mainTimeframe: ReplayVideoTimeframe;
  secondaryTimeframes: ReplayVideoSecondaryTimeframes;
  cancelled: () => boolean;
  onProgress: (percent: number) => void;
}) {
  let writeQueue = Promise.resolve();
  let writeError: unknown = null;
  let recorderError: unknown = null;
  let pendingBytes = 0;
  let recorderStarted = false;
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.addEventListener("error", () => {
    recorderError = new Error("视频编码器发生错误");
    if (recorder.state !== "inactive") recorder.stop();
  }, { once: true });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    pendingBytes += event.data.size;
    if (pendingBytes > 128 * 1024 * 1024) {
      writeError = new Error("视频写入速度不足，已停止以避免占用过多内存");
      if (recorder.state !== "inactive") recorder.stop();
      return;
    }
    writeQueue = writeQueue
      .then(() => sink.write(event.data))
      .then(() => { pendingBytes -= event.data.size; })
      .catch((error) => {
        writeError = error;
        if (recorder.state !== "inactive") recorder.stop();
      });
  });

  let primaryError: unknown = null;
  try {
    const firstFrame = plan.frames[0];
    renderReplayVideoFrame(canvas, {
      trade,
      candles,
      openInterest,
      candleIndex: firstFrame.candleIndex,
      phase: firstFrame.phase,
      entryIndex: plan.range.entryIndex,
      range: plan.range,
      timeframe: mainTimeframe,
      secondaryTimeframes,
      speed,
      source,
      indicatorVisibility,
      volumeColoringConfig,
    });
    recorder.start(1_000);
    recorderStarted = true;
    onProgress(5);
    const recordingStartedAt = performance.now();

    for (const videoFrame of plan.frames) {
      if (cancelled()) throw abortError();
      if (writeError) throw writeError;
      if (recorderError) throw recorderError;
      if (recorder.state === "inactive") {
        throw new Error("视频编码器意外停止");
      }
      renderReplayVideoFrame(canvas, {
        trade,
        candles,
        openInterest,
        candleIndex: videoFrame.candleIndex,
        phase: videoFrame.phase,
        entryIndex: plan.range.entryIndex,
        range: plan.range,
        timeframe: mainTimeframe,
        secondaryTimeframes,
        speed,
        source,
        indicatorVisibility,
        volumeColoringConfig,
      });
      const percent = 5 + (videoFrame.frameIndex + 1) / plan.frames.length * 90;
      if (videoFrame.frameIndex % 6 === 0 || videoFrame.isLastFrame) {
        onProgress(percent);
      }
      const targetTime = recordingStartedAt +
        videoFrame.elapsedMs +
        videoFrame.durationMs;
      await delay(Math.max(0, targetTime - performance.now()));
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (recorderStarted) {
      if (recorder.state !== "inactive") recorder.stop();
      try {
        await stopped;
      } catch (error) {
        primaryError ??= error;
      }
    }
    try {
      await writeQueue;
    } catch (error) {
      primaryError ??= error;
    }
  }

  if (!primaryError && writeError) primaryError = writeError;
  if (!primaryError && recorderError) primaryError = recorderError;
  if (primaryError) throw primaryError;
}

function selectRecorderFormat(): RecorderFormat {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("当前环境不支持视频编码");
  }
  const candidates: RecorderFormat[] = [
    { mimeType: "video/mp4;codecs=avc1.640028", extension: "mp4", label: "MP4" },
    { mimeType: "video/mp4", extension: "mp4", label: "MP4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm", label: "WebM" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm", label: "WebM" },
    { mimeType: "video/webm", extension: "webm", label: "WebM" },
  ];
  const probeCanvas = document.createElement("canvas");
  const captureStream = probeCanvas.captureStream;
  if (typeof captureStream !== "function") {
    throw new Error("当前环境不支持 Canvas 视频录制");
  }
  const probeStream = captureStream.call(probeCanvas, 1);
  try {
    for (const candidate of candidates) {
      if (!MediaRecorder.isTypeSupported(candidate.mimeType)) continue;
      try {
        new MediaRecorder(probeStream, {
          mimeType: candidate.mimeType,
          videoBitsPerSecond: 10_000_000,
        });
        return candidate;
      } catch {
        // 某些 Chromium 版本会声明支持编码，但构造编码器时仍失败，继续尝试下一种格式。
      }
    }
  } finally {
    probeStream.getTracks().forEach((track) => track.stop());
  }
  throw new Error("当前设备没有可用的 MP4 或 WebM 视频编码器");
}

async function createVideoSink({
  format,
  suggestedName,
}: {
  format: RecorderFormat;
  suggestedName: string;
}): Promise<VideoSink | null> {
  const desktop = window.cryptoReviewDesktop;
  if (
    desktop?.beginVideoExport &&
    desktop.appendVideoExport &&
    desktop.completeVideoExport &&
    desktop.cancelVideoExport
  ) {
    const begun = await desktop.beginVideoExport({
      suggestedName,
      mimeType: format.mimeType,
    });
    if (begun.canceled || !begun.exportId) return null;
    const exportId = begun.exportId;
    return {
      fileName: begun.filePath ?? suggestedName,
      memoryBacked: false,
      async write(chunk) {
        const bytes = new Uint8Array(await chunk.arrayBuffer());
        await desktop.appendVideoExport({ exportId, chunk: bytes });
      },
      async complete() {
        await desktop.completeVideoExport(exportId);
      },
      async cancel() {
        await desktop.cancelVideoExport(exportId);
      },
    };
  }

  const picker = (window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      name: string;
      createWritable(): Promise<{
        write(data: Blob): Promise<void>;
        close(): Promise<void>;
        abort?(): Promise<void>;
      }>;
    }>;
  }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: `${format.label} 视频`,
          accept: { [format.mimeType.split(";")[0]]: [`.${format.extension}`] },
        }],
      });
      const writable = await handle.createWritable();
      return {
        fileName: handle.name,
        memoryBacked: false,
        write: (chunk) => writable.write(chunk),
        complete: () => writable.close(),
        cancel: () => writable.abort?.() ?? Promise.resolve(),
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
  }

  const chunks: Blob[] = [];
  return {
    fileName: suggestedName,
    memoryBacked: true,
    async write(chunk) { chunks.push(chunk); },
    async complete() {
      const blob = new Blob(chunks, { type: format.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggestedName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async cancel() { chunks.length = 0; },
  };
}

function getFinalExitTimeMs(trade: ReplayVideoExportTrade) {
  if (trade.openPosition) return null;
  const exits = Array.isArray(trade.exits) ? trade.exits : [];
  if (exits.length > 0) {
    const exitedQuantity = exits.reduce((sum, exit) => sum + Number(exit.quantity || 0), 0);
    if (exitedQuantity < trade.quantity - 1e-10) return null;
    const times = exits.map((exit) => parseTime(exit.exitTime));
    if (times.some((time) => time === null)) return null;
    return Math.max(...(times as number[]));
  }
  if (!trade.exitPrice) return null;
  return parseTime(trade.exitTime);
}

function buildVideoFileName(
  trade: ReplayVideoExportTrade,
  frame: VideoTimeFrame,
  extension: string,
) {
  const entryTime = parseTime(trade.entryTime) ?? Date.now();
  const date = new Date(entryTime + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", "-")
    .replace(":", "");
  const symbol = trade.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${symbol}-${date}-${frame}-复盘.${extension}`;
}

function parseTime(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

function drawPreviewPlaceholder(canvas: HTMLCanvasElement, message: string) {
  canvas.width = REPLAY_VIDEO_WIDTH;
  canvas.height = REPLAY_VIDEO_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#090f16";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4b860";
  context.font = '700 32px "Microsoft YaHei", sans-serif';
  context.textAlign = "center";
  context.fillText("CryptoReview · 1080P 交易复盘", canvas.width / 2, canvas.height / 2 - 18);
  context.fillStyle = "#8d9aa8";
  context.font = '20px "Microsoft YaHei", sans-serif';
  context.fillText(message, canvas.width / 2, canvas.height / 2 + 28);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function abortError() {
  return new DOMException("视频导出已取消", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
