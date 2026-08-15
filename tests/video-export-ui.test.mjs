import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("单笔复盘提供可配置的 1080P 视频导出入口", async () => {
  const [tradeReplay, videoExport, renderer] = await Promise.all([
    readFile(new URL("app/components/TradeReplay.tsx", projectUrl), "utf8"),
    readFile(new URL("app/components/ReplayVideoExport.tsx", projectUrl), "utf8"),
    readFile(new URL("app/lib/replay-video-renderer.ts", projectUrl), "utf8"),
  ]);

  assert.match(tradeReplay, /<ReplayVideoExport/);
  assert.match(tradeReplay, /onExportStart=\{\(\) => setPlaying\(false\)\}/);
  assert.match(videoExport, /默认 10 根/);
  assert.match(videoExport, /默认 100 根/);
  assert.match(videoExport, /SPEED_OPTIONS = \[0\.5, 1, 2, 4\]/);
  assert.match(videoExport, /captureStream\.call\(canvasRef\.current, 30\)/);
  assert.match(videoExport, /new MediaRecorder/);
  assert.match(videoExport, /fetchVideoExportCandles/);
  assert.match(videoExport, /fetchVideoOpenInterest/);
  assert.match(videoExport, /历史 OI 不完整，视频中已隐藏 OI/);
  assert.match(renderer, /REPLAY_VIDEO_WIDTH = 1920/);
  assert.match(renderer, /REPLAY_VIDEO_HEIGHT = 1080/);
  assert.match(renderer, /drawChart/);
  assert.match(renderer, /buildFixedReplayContext/);
  assert.match(renderer, /drawMultiTimeframePanels/);
  assert.match(videoExport, /VIDEO_TIMEFRAME_OPTIONS/);
  assert.match(videoExport, /aria-label="视频主图时间框架"/);
  assert.match(videoExport, /aria-label=\{`视频副图 \$\{index \+ 1\} 时间框架`\}/);
  assert.match(videoExport, /const \[mainTimeframe, setMainTimeframe\]/);
  assert.match(videoExport, /const \[secondaryTimeframes, setSecondaryTimeframes\]/);
  assert.match(videoExport, /timeframe:\s*mainTimeframe/);
  assert.match(videoExport, /secondaryTimeframes,/);
  assert.match(renderer, /"1H"/);
  assert.match(renderer, /"4H"/);
  assert.match(renderer, /"1D"/);
  assert.match(renderer, /buildReplayPositionState/);
  assert.match(renderer, /positionState: ReplayPositionState/);
  assert.match(
    renderer,
    /drawChart\(context, state\);\s*drawMultiTimeframePanels\(context, state\);\s*drawPositionBar\(context, state\);\s*drawProgress\(context, state\);/,
  );
  assert.match(renderer, /const POSITION_BAR_Y = 950/);
  assert.match(renderer, /const POSITION_BAR_TRACK_X = 160/);
  assert.match(renderer, /const POSITION_BAR_TRACK_WIDTH = 1728/);
  assert.match(renderer, /LONG_POSITION_COLORS/);
  assert.match(renderer, /SHORT_POSITION_COLORS/);
  assert.match(renderer, /segment\.colorIndex % palette\.length/);
  assert.match(
    renderer,
    /positionState = buildReplayPositionState\(input\.trade, replayTimeMs\)/,
  );
  assert.doesNotMatch(renderer, /drawExecutionPanel/);
  assert.match(renderer, /drawProgress/);
  assert.match(renderer, /buildReplayProgressNodes/);
  assert.match(renderer, /WeakMap/);
  assert.match(renderer, /createReplayTimeframeAggregator/);
  assert.match(renderer, /TIMEFRAME_AGGREGATOR_CACHE/);
  assert.match(videoExport, /VIDEO_BASE_FRAME = "5m"/);
  assert.match(renderer, /mainTimeframe: ReplayVideoTimeframe/);
  assert.match(renderer, /secondaryTimeframes: ReplayVideoSecondaryTimeframes/);
  assert.match(renderer, /state\.secondaryTimeframes\.forEach/);
  assert.match(renderer, /buildVolumeCandleColorPoint/);
  assert.match(renderer, /volumeColoringConfig/);
  assert.match(renderer, /borderColor|COLORS\.ink/);
  assert.match(tradeReplay, /volumeColoringConfig=\{volumeColoringConfig\}/);
});

test("视频数据不足时独立分页获取，不扩大当前回放窗口", async () => {
  const [videoExport, videoMarket, tradeReplay] = await Promise.all([
    readFile(new URL("app/components/ReplayVideoExport.tsx", projectUrl), "utf8"),
    readFile(new URL("lib/video-market.mjs", projectUrl), "utf8"),
    readFile(new URL("app/components/TradeReplay.tsx", projectUrl), "utf8"),
  ]);

  assert.match(videoExport, /EMA_WARMUP_CANDLES = 280/);
  assert.match(videoExport, /MULTI_TIMEFRAME_HISTORY_DAYS = 31/);
  assert.match(videoExport, /VIDEO_CHART_CONTEXT_CANDLES = 80/);
  assert.match(videoExport, /interval: VIDEO_BASE_FRAME/);
  assert.match(videoExport, /period: VIDEO_BASE_FRAME/);
  assert.match(videoExport, /演示行情不会联网补齐视频数据/);
  assert.match(videoMarket, /const PAGE_LIMIT = 1000/);
  assert.match(videoMarket, /pageMaxCloseTime/);
  assert.doesNotMatch(tradeReplay, /postExitCandles/);
});

test("视频成交箭头在可视窗口内持续显示，成本线使用当前回放的动态加权价", async () => {
  const renderer = await readFile(
    new URL("app/lib/replay-video-renderer.ts", projectUrl),
    "utf8",
  );

  assert.doesNotMatch(
    renderer,
    /if \(!state\.hasEntered \|\| state\.safeEntryIndex < chartStartIndex\) return;/,
  );
  assert.doesNotMatch(renderer, /priceY\(state\.trade\.entryPrice\)/);
  assert.match(renderer, /buildReplayTradeSnapshot/);
  assert.match(renderer, /tradeSnapshot: ReplayTradeSnapshot/);
  assert.match(renderer, /state\.tradeSnapshot\.events/);
  assert.match(renderer, /state\.tradeSnapshot\.averageEntryPrice/);
  assert.match(renderer, /pnl: tradeSnapshot\.pnl/);
  assert.doesNotMatch(renderer, /calculateTradePnl\(/);
});
