export interface VideoExportConfig {
  preEntryCandles: number;
  postExitCandles: number;
  playbackSpeed: number;
  framesPerCandle: number;
}

export interface VideoExportConfigInput {
  preEntryCandles?: number | string;
  postExitCandles?: number | string;
  playbackSpeed?: number | string;
  framesPerCandle?: number | string;
}

export interface VideoExportResolution {
  width: 1920;
  height: 1080;
}

export interface VideoExportCandle {
  time: number;
  closeTime?: number | null;
}

export interface VideoExportTradeExit {
  quantity: number;
  exitPrice: number;
  exitTime: string | number | null;
}

export interface VideoExportTrade {
  quantity: number;
  entryTime: string | number | null;
  exits?: VideoExportTradeExit[];
  exitQuantity?: number | string | null;
  exitPrice?: number | null;
  exitTime?: string | number | null;
  openPosition?: object | null;
}

export interface VideoExportWindow {
  entryIndex: number;
  finalExitIndex: number;
  startIndex: number;
  endIndex: number;
  candleCount: number;
  entryTimeMs: number;
  finalExitTimeMs: number;
  preEntryCandles: number;
  postExitCandles: number;
}

export interface VideoExportFrame {
  frameIndex: number;
  candleIndex: number;
  relativeCandleIndex: number;
  phase: number;
  replayTimeMs: number;
  elapsedMs: number;
  durationMs: number;
  isLastFrame: boolean;
}

export interface VideoExportFramePlan {
  resolution: VideoExportResolution;
  config: VideoExportConfig;
  range: VideoExportWindow;
  frameDurationMs: number;
  totalDurationMs: number;
  frames: VideoExportFrame[];
}

export const VIDEO_EXPORT_DEFAULTS: Readonly<VideoExportConfig>;
export const VIDEO_EXPORT_RESOLUTION: Readonly<VideoExportResolution>;

export function normalizeVideoExportConfig(
  input?: VideoExportConfigInput,
): VideoExportConfig;

export function resolveVideoExportWindow(
  trade: VideoExportTrade,
  candles: VideoExportCandle[],
  inputConfig?: VideoExportConfigInput,
): VideoExportWindow;

export function buildVideoExportFramePlan(
  candles: VideoExportCandle[],
  range: VideoExportWindow,
  inputConfig?: VideoExportConfigInput,
): VideoExportFramePlan;

export function createVideoExportPlan(
  trade: VideoExportTrade,
  candles: VideoExportCandle[],
  inputConfig?: VideoExportConfigInput,
): VideoExportFramePlan;
