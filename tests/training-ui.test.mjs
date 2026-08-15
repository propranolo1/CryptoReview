import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("顶部提供独立训练模式且不会混入历史交易表现", async () => {
  const source = await readFile(
    new URL("../app/components/TradeReplay.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /type ActiveModule = "replay" \| "performance" \| "training"/);
  assert.match(source, /训练模式/);
  assert.match(source, /aria-controls="training-module"/);
  assert.match(source, /<TrainingMode/);
  assert.match(source, /hidden=\{activeModule !== "training"\}/);
  assert.match(source, /trainingResults=/);
  assert.match(source, /onResultsChange=/);
  assert.match(source, /saveTrainingResults/);
});

test("训练界面隐藏未来行情并支持买卖、分仓和单独表现看板", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /开始训练/);
  assert.match(component, /BTCUSDT/);
  assert.match(component, /Binance Futures/);
  assert.match(component, /未来行情已隐藏/);
  assert.match(component, /下一根 K 线/);
  assert.match(component, /买入/);
  assert.match(component, /卖出/);
  assert.match(component, /\(\[0\.1, 0\.25, 0\.5, 1\] as OrderRatio\[\]\)/);
  assert.match(component, /Math\.round\(value \* 100\)/);
  assert.match(component, /applyTrainingAction/);
  assert.match(component, /训练表现/);
  assert.match(component, /calculateTrainingPerformance/);
  assert.match(styles, /\.trainingWorkspace/);
  assert.match(styles, /\.trainingChart/);
  assert.match(styles, /\.performanceBoard/);
});

test("训练界面支持右方向键推进、持仓续接行情，并阻止持仓时直接结束", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );

  assert.match(component, /event\.key !== "ArrowRight"/);
  assert.match(component, /isTrainingKeyboardInput\(event\.target\)/);
  assert.match(component, /closest\("\[hidden\]"\)/);
  assert.match(component, /window\.addEventListener\("keydown"/);
  assert.match(component, /window\.removeEventListener\("keydown"/);
  assert.match(component, /event\.preventDefault\(\)/);

  assert.match(component, /createTrainingContinuationRequest/);
  assert.match(component, /prepareTrainingContinuationCandles/);
  assert.match(component, /const \[loadingMore, setLoadingMore\] = useState\(false\)/);
  assert.match(component, /startTime: lastCandle\.closeTime \+ 1/);
  assert.match(component, /afterCloseTime: lastCandle\.closeTime/);
  assert.match(component, /setCursor\(nextCursor\)/);
  assert.match(component, /查看后续 K 线/);
  assert.doesNotMatch(
    component,
    /if \(!session\.position && session\.limitOrders\.length === 0\) \{\s*finishTraining\(\);\s*return;/,
  );

  assert.match(
    component,
    /if \(session\.position\) \{\s*setNotice\("请先全部平仓，再结束并保存训练"\);\s*return false;/,
  );
  assert.match(component, /if \(session\.limitOrders\.length > 0\)/);
  assert.match(component, /disabled=\{!canStartNewRound \|\| loading\}/);
  assert.doesNotMatch(component, /training-auto-close/);
  assert.doesNotMatch(component, /SELL 结束平多|BUY 结束平空/);
  assert.doesNotMatch(component, /exitPrice: currentCandle\.close/);
});

test("空仓无挂单时可以保存并开始新一局，不依赖底层游标是否到末尾", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    component,
    /const canStartNewRound = canStartNewTrainingRound\(session\)/,
  );
  assert.match(
    component,
    /if \(session && !finishTraining\(\)\) return false;\s*await startTraining\(\);\s*return true;/,
  );
  assert.match(component, /onClick=\{\(\) => void startNewRound\(\)\}/);
  assert.match(component, /disabled=\{!canStartNewRound \|\| loading\}/);
});

test("训练图表可拖动成本线设置 TP/SL，并沿用顶部本次操作比例", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /setTrainingRiskLevels/);
  assert.match(component, /processTrainingCandle/);
  assert.match(component, /priceToCoordinate/);
  assert.match(component, /coordinateToPrice/);
  assert.match(component, /addEventListener\("pointerdown"/);
  assert.match(component, /addEventListener\("pointermove"/);
  assert.match(component, /addEventListener\("pointerup"/);
  assert.match(component, /setPointerCapture/);
  assert.match(component, /title: takeProfitLabel/);
  assert.match(component, /title: stopLossLabel/);
  assert.match(component, /takeProfitRatio: ratio/);
  assert.match(component, /stopLossRatio: ratio/);
  assert.doesNotMatch(component, /className=\{styles\.riskHintRail\}/);
  assert.doesNotMatch(component, /拖动黄色成本线设置止盈止损；右键价格设置限价单/);
  assert.doesNotMatch(component, /styles\.hasRiskHint/);
  assert.doesNotMatch(styles, /\.hasRiskHint\s*\{/);
  assert.doesNotMatch(styles, /\.riskHintRail\s*\{/);
  assert.doesNotMatch(styles, /\.riskDragHint\s*\{/);
  assert.match(styles, /\.riskDragReady/);
  assert.match(styles, /\.riskDragging/);
});

test("训练图表右键价格可设置带比例的 BUY SELL 限价单并显示挂单线", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /placeTrainingLimitOrder/);
  assert.match(component, /cancelTrainingLimitOrder/);
  assert.match(component, /onContextMenu=\{handleLimitContextMenu\}/);
  assert.match(component, /onClick=\{handleChartClick\}/);
  assert.match(component, /coordinateToPrice/);
  assert.match(component, /priceToCoordinate\(order\.price\)/);
  assert.match(component, /BUY LIMIT/);
  assert.match(component, /SELL LIMIT/);
  assert.match(component, /limitOrders\.map/);
  assert.match(component, /limitOrderLineRefs/);
  assert.match(component, /onCancelLimitOrder/);
  assert.match(component, /取消该限价单/);
  assert.match(styles, /\.limitOrderMenu/);
  assert.match(styles, /\.limitCancelMenu/);
});

test("训练主图支持水平线、带填充色矩形框，并可清空绘图", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /type TrainingDrawingMode\s*=\s*"none"\s*\|\s*"horizontal"\s*\|\s*"rectangle"/);
  assert.match(component, /aria-label="训练绘图工具"/);
  assert.match(component, /水平线/);
  assert.match(component, /矩形框/);
  assert.doesNotMatch(component, /type="color"/);
  assert.match(component, /aria-label="绘图颜色"/);
  assert.match(component, /label:\s*"灰色"/);
  assert.match(component, /label:\s*"绿色"/);
  assert.match(component, /label:\s*"红色"/);
  assert.match(component, /coordinateToTime/);
  assert.match(component, /coordinateToLogical/);
  assert.match(component, /logicalToCoordinate/);
  assert.match(component, /coordinateToPrice/);
  assert.match(component, /timeToCoordinate/);
  assert.match(component, /priceToCoordinate/);
  assert.match(component, /<svg/);
  assert.match(component, /<rect/);
  assert.match(component, /<line/);
  assert.match(component, /清空绘图/);
  assert.match(styles, /\.drawingToolbar/);
  assert.match(styles, /\.drawingOverlay/);
  assert.match(styles, /\.drawingActive/);
});

test("训练矩形可选中、拖动和通过四个角点调整", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /moveTrainingRectangle/);
  assert.match(component, /resizeTrainingRectangle/);
  assert.match(component, /selectedDrawingId/);
  assert.match(component, /handleRectanglePointerDown/);
  assert.match(component, /addEventListener\("pointermove"/);
  assert.match(component, /addEventListener\("pointerup"/);
  assert.match(component, /topLeft/);
  assert.match(component, /topRight/);
  assert.match(component, /bottomLeft/);
  assert.match(component, /bottomRight/);
  assert.match(component, /<circle/);
  assert.match(styles, /\.drawingRectangle/);
  assert.match(styles, /\.drawingHandle/);
  assert.match(styles, /\.drawingColorSwatch/);
});

test("训练绘图在 15m、1H、4H、1D 主图与高周期小图间同步", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);
  const miniChartSource = component.slice(
    component.indexOf("function TrainingMiniChart"),
    component.indexOf("function TrainingChart"),
  );
  const modeSource = component.slice(component.indexOf("export function TrainingMode"));

  assert.match(component, /getTrainingDrawingBucketRange/);
  assert.match(component, /function useTrainingDrawingProjection/);
  assert.match(modeSource, /const \[drawings,\s*setDrawings\]\s*=\s*useState<TrainingChartDrawing\[\]>/);
  assert.match(component, /drawings:\s*readonly TrainingChartDrawing\[\]/);
  assert.match(miniChartSource, /useTrainingDrawingProjection/);
  assert.match(miniChartSource, /className=\{styles\.trainingMiniDrawingOverlay\}/);
  assert.match(
    modeSource,
    /<TrainingChart[\s\S]*?drawings=\{drawings\}[\s\S]*?onDrawingsChange=\{setDrawings\}/,
  );
  assert.match(
    modeSource,
    /<TrainingMiniChart[\s\S]*?label="4H"[\s\S]*?drawings=\{drawings\}/,
  );
  assert.match(
    modeSource,
    /<TrainingMiniChart[\s\S]*?label="1D"[\s\S]*?drawings=\{drawings\}/,
  );
  assert.doesNotMatch(component, /drawing\.timeframe\s*!==\s*timeframe/);
  assert.match(styles, /\.trainingMiniDrawingOverlay/);
});

test("训练 TP 和 SL 可分别设置 10%、25%、50% 或 100% 平仓比例", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );

  assert.match(component, /\(\[0\.1, 0\.25, 0\.5, 1\] as OrderRatio\[\]\)/);
  assert.match(component, /takeProfitRatio: ratio/);
  assert.match(component, /stopLossRatio: ratio/);
  assert.match(component, /trigger\.positionRatio/);
  assert.match(component, /部分平仓/);
});

test("训练主图可切换 15m、1H、4H、1D，所有周期只使用已揭示行情", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /type TrainingMainTimeframe\s*=\s*"15m"\s*\|\s*"1H"\s*\|\s*"4H"\s*\|\s*"1D"/);
  assert.match(component, /const \[mainTimeframe,\s*setMainTimeframe\]/);
  assert.match(component, /aria-label="训练主图时间框架"/);
  assert.match(component, /"15m":\s*"15 分钟"/);
  assert.match(component, /"1H":\s*"1 小时"/);
  assert.match(component, /"4H":\s*"4 小时"/);
  assert.match(component, /"1D":\s*"1 天"/);
  assert.match(
    component,
    /createRandomTrainingRequest\(\{\s*interval:\s*TRAINING_MAIN_INTERVAL,/,
  );
  assert.match(
    component,
    /createTrainingContinuationRequest\(\{\s*interval:\s*TRAINING_MAIN_INTERVAL,/,
  );
  assert.match(
    component,
    /createReplayTimeframeAggregator\(candles\)/,
  );
  assert.match(
    component,
    /timeframeAggregator\.build\(\{\s*cursor,\s*replayTimeMs:\s*currentCandle\.closeTime,\s*currentCandle,/,
  );
  assert.match(component, /timeframes\["4H"\]/);
  assert.match(component, /timeframes\["1D"\]/);
  assert.match(component, /aria-label="4H 训练周期图"/);
  assert.match(component, /aria-label="1D 训练周期图"/);
  assert.match(component, /const TRAINING_CONTEXT_CANDLES\s*=\s*8_640/);
  assert.match(component, /"1D":\s*90/);
  assert.match(component, /TRAINING_MINI_VISIBLE_CANDLES\[label\]/);
  assert.match(component, /const TRAINING_FUTURE_CANDLES\s*=\s*160/);
  assert.match(component, /createTrainingHistoryRequest/);
  assert.match(component, /mergeTrainingHistoryPages/);
  assert.match(component, /contextCandles:\s*TRAINING_CONTEXT_CANDLES/);
  assert.match(component, /trainingCandles:\s*TRAINING_FUTURE_CANDLES/);
  assert.match(component, /createXinMentorshipAccumulator/);
  const miniChartSource = component.slice(
    component.indexOf("function TrainingMiniChart"),
    component.indexOf("function TrainingChart"),
  );
  const mainChartSource = component.slice(
    component.indexOf("function TrainingChart"),
    component.indexOf("type TrainingAuditRecord"),
  );
  assert.doesNotMatch(miniChartSource, /xinWt1SeriesRef|xinMomentumSeriesRef/);
  assert.match(mainChartSource, /xinWt1SeriesRef/);
  assert.match(mainChartSource, /xinMomentumSeriesRef/);
  assert.match(component, /XIN Mentorship/);
  assert.match(
    component,
    /xinChartMarkersRef\.current[\s\S]*?xinMarkerApi\.setMarkers\(xinChartMarkersRef\.current\)/,
  );

  assert.match(styles, /\.trainingChartLayout/);
  assert.match(styles, /\.trainingTimeframeRail/);
  assert.match(styles, /\.trainingMiniChart/);
});

test("训练主图与高周期小图使用成交量染色且始终保留黑色描边和影线", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );
  const miniChartSource = component.slice(
    component.indexOf("function TrainingMiniChart"),
    component.indexOf("function TrainingChart"),
  );
  const mainChartSource = component.slice(
    component.indexOf("function TrainingChart"),
    component.indexOf("type TrainingAuditRecord"),
  );

  assert.match(component, /buildVolumeCandleColorSeries/);
  assert.match(component, /function buildTrainingCandleData/);
  assert.match(component, /borderColor:\s*"#111111"/);
  assert.match(component, /wickColor:\s*"#111111"/);
  assert.match(miniChartSource, /buildTrainingCandleDataWindow\(candles, visibleStart\)/);
  assert.match(miniChartSource, /buildVolumeCandleColorPoint\(candles, candles\.length - 1\)/);
  assert.match(mainChartSource, /buildTrainingCandleData\(candles\)/);
  assert.match(mainChartSource, /candleSeries\.update\(buildTrainingCandleDatum/);
});

test("训练 4H 和 1D 小图支持独立缩放，并在同一训练局保留手动视口", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );
  const chartStart = component.indexOf("function TrainingMiniChart(");
  const chartEnd = component.indexOf("function TrainingChart(", chartStart);
  assert.notEqual(chartStart, -1);
  assert.notEqual(chartEnd, -1);
  const chart = component.slice(chartStart, chartEnd);

  assert.match(chart, /handleScroll:\s*true/);
  assert.match(chart, /handleScale:\s*true/);
  assert.match(chart, /viewportSessionIdRef/);
  assert.match(chart, /sessionId:/);
  assert.match(
    chart,
    /if\s*\([\s\S]*?visible\.length\s*>\s*0\s*&&[\s\S]*?viewportSessionIdRef\.current\s*!==\s*sessionId[\s\S]*?\)\s*\{[\s\S]*?setVisibleLogicalRange/,
  );
  assert.equal(chart.match(/setVisibleLogicalRange/g)?.length, 1);
  assert.match(
    component,
    /<TrainingMiniChart[\s\S]*?label="4H"[\s\S]*?candles=\{timeframes\["4H"\]\}[\s\S]*?sessionId=\{context\?\.sessionId\s*\?\?\s*"training-uninitialized"\}/,
  );
  assert.match(
    component,
    /<TrainingMiniChart[\s\S]*?label="1D"[\s\S]*?candles=\{timeframes\["1D"\]\}[\s\S]*?sessionId=\{context\?\.sessionId\s*\?\?\s*"training-uninitialized"\}/,
  );
});

test("训练 4H 和 1D 小图在 K 线下方显示涨绿跌红成交量", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );
  const chartStart = component.indexOf("function TrainingMiniChart(");
  const chartEnd = component.indexOf("function TrainingChart(", chartStart);
  assert.notEqual(chartStart, -1);
  assert.notEqual(chartEnd, -1);
  const chart = component.slice(chartStart, chartEnd);

  assert.match(chart, /volumeSeriesRef/);
  assert.match(
    chart,
    /addSeries\(library\.HistogramSeries,[\s\S]*?\},\s*1\)/,
  );
  assert.match(chart, /panes\[0\]\?\.setStretchFactor\(4\)/);
  assert.match(chart, /panes\[1\]\?\.setStretchFactor\(1\)/);
  assert.match(chart, /volumeSeries\.setData\(visible\.map\(buildTrainingVolumeDatum\)\)/);
  assert.match(chart, /volumeSeries\.update\(buildTrainingVolumeDatum\(latest\)\)/);
  assert.match(component, /value:\s*candle\.volume/);
  assert.match(component, /candle\.close\s*>=\s*candle\.open/);
  assert.match(component, /rgba\(48,\s*196,\s*135,\s*0\.58\)/);
  assert.match(component, /rgba\(239,\s*101,\s*114,\s*0\.58\)/);
});

test("训练推进使用增量序列、缓存指标和差异价格线更新", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );
  const chartStart = component.indexOf("function TrainingChart(");
  const chartEnd = component.indexOf("function describeTrainingAction(", chartStart);
  const chart = component.slice(chartStart, chartEnd);

  assert.match(chart, /classifyTrainingSeriesUpdate/);
  assert.match(chart, /updateMode === "append"/);
  assert.match(chart, /candleSeries\.update/);
  assert.match(chart, /volumeSeries\.update/);
  assert.match(chart, /nextAccumulator\.append\(latestCandle\)/);
  assert.match(chart, /nextAccumulator\.replaceLast\(latestCandle\)/);
  assert.match(chart, /costLineRef\.current\.applyOptions/);
  assert.match(chart, /takeProfitLineRef\.current\.applyOptions/);
  assert.match(chart, /stopLossLineRef\.current\.applyOptions/);
  assert.doesNotMatch(
    chart,
    /for \(const line of limitOrderLineRefs\.current\.values\(\)\)[\s\S]*?limitOrderLineRefs\.current\.clear\(\)/,
  );
  assert.match(component, /window\.requestAnimationFrame/);
  assert.match(component, /trainingProjectedDrawingsEqual/);
});

test("训练表现支持 JSON 导出导入，并在确认后清空已完成记录", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );

  assert.match(component, /serializeTrainingResultsExport/);
  assert.match(component, /parseTrainingResultsImport/);
  assert.match(component, /mergeTrainingResultRecords/);
  assert.match(component, /accept="\.json,application\/json"/);
  assert.match(component, /导出记录/);
  assert.match(component, /导入记录/);
  assert.match(component, /清空记录/);
  assert.match(component, /window\.confirm\(/);
  assert.match(component, /onResultsChange\(\[\]\)/);
});

test("训练主图只在新训练局或切换周期时初始化范围，逐根推进不覆盖用户手动缩放", async () => {
  const component = await readFile(
    new URL("../app/components/TrainingMode.tsx", import.meta.url),
    "utf8",
  );
  const chartStart = component.indexOf("function TrainingChart(");
  const chartEnd = component.indexOf("function describeTrainingAction(", chartStart);
  assert.notEqual(chartStart, -1);
  assert.notEqual(chartEnd, -1);
  const chart = component.slice(chartStart, chartEnd);

  assert.match(chart, /viewportSessionIdRef/);
  assert.match(chart, /sessionId:/);
  assert.match(chart, /const viewportKey = `\$\{sessionId\}:\$\{timeframe\}`/);
  assert.match(
    chart,
    /if\s*\(viewportSessionIdRef\.current\s*!==\s*viewportKey\)\s*\{[\s\S]*?setVisibleLogicalRange/,
  );
  assert.equal(chart.match(/setVisibleLogicalRange/g)?.length, 1);
});

test("训练顶部操作栏保留全部交易控制，图表撑满页面且不再显示下方双面板", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);
  const toolbarStart = component.indexOf('<div className={styles.trainingToolbar}>');
  const toolbarEnd = component.indexOf('{notice &&', toolbarStart);
  assert.notEqual(toolbarStart, -1);
  assert.notEqual(toolbarEnd, -1);
  const toolbar = component.slice(toolbarStart, toolbarEnd);

  assert.match(toolbar, /className=\{styles\.trainingQuickTrade\}/);
  assert.match(toolbar, /aria-label="本次操作比例"/);
  assert.match(toolbar, /tradeByDirection\("buy"\)/);
  assert.match(toolbar, /tradeByDirection\("sell"\)/);
  assert.match(toolbar, /onClick=\{\(\) => void nextCandle\(\)\}/);
  assert.match(toolbar, /加载后续….*下一根 K 线/s);
  assert.match(toolbar, /当前盈亏/);
  assert.match(toolbar, /可用资金/);
  assert.match(toolbar, /conic-gradient/);
  assert.doesNotMatch(component, /className=\{styles\.trainingBottom\}/);
  assert.doesNotMatch(component, /aria-label="模拟下单"/);
  assert.doesNotMatch(component, /aria-label="训练账户"/);
  assert.match(styles, /\.trainingQuickTrade/);
  assert.match(styles, /\.capitalRing/);
  assert.match(styles, /\.trainingDesk\s*\{[\s\S]*?min-height:\s*calc\(100dvh - 145px\)/);
  assert.match(styles, /\.trainingChartLayout\s*\{[\s\S]*?min-height:\s*calc\(100dvh - 231px\)/);
});

test("训练结束显示总结卡并在图表 TP/SL 标签中预览预期结果", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /buildTrainingSessionSummary/);
  assert.match(component, /calculateTrainingRiskExpectation/);
  assert.match(component, /本局训练总结/);
  assert.match(component, /本局盈利/);
  assert.match(component, /R 倍数/);
  assert.match(component, /最大浮盈 MFE/);
  assert.match(component, /最大浮亏 MAE/);
  assert.match(component, /平均持仓 K 线/);
  assert.match(component, /加仓次数/);
  assert.match(component, /减仓次数/);
  assert.match(component, /const takeProfitLabel = riskExpectation\.takeProfit/);
  assert.match(component, /const stopLossLabel = riskExpectation\.stopLoss/);
  assert.match(styles, /\.trainingSummaryCard/);
});

test("训练表现显示 R、回撤、连续盈亏、持仓时间、MAE 及方向周期分组", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /calculateTrainingAnalyticsPerformance/);
  assert.match(component, /平均 R/);
  assert.match(component, /最大回撤/);
  assert.match(component, /最大连续盈利/);
  assert.match(component, /最大连续亏损/);
  assert.match(component, /平均持仓时间/);
  assert.match(component, /平均最大浮亏/);
  assert.match(component, /方向表现/);
  assert.match(component, /时间框架表现/);
  assert.match(styles, /\.performanceBreakdown/);
  assert.match(styles, /\.performanceTable/);
});

test("训练操作日志使用权威动作记录并显示完整 K 线、仓位和风控历史", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /function createTrainingMarketLocation/);
  assert.match(component, /marketLocation:\s*createTrainingMarketLocation/);
  assert.match(component, /function TrainingOperationTable/);
  assert.match(component, /record\.actions/);
  assert.match(component, /record\.riskChanges/);
  assert.match(component, /行情时间 \/ K线/);
  assert.match(component, /本次数量/);
  assert.match(component, /操作前仓位/);
  assert.match(component, /操作后仓位/);
  assert.match(component, /本次 \/ 累计盈亏/);
  assert.match(component, /现实记录/);
  assert.match(component, /历史操作明细/);
  assert.match(component, /intrabar-unknown/);
  assert.match(component, /actionId/);
  assert.doesNotMatch(
    component,
    /\{\[\.\.\.markers\]\.reverse\(\)\.map\(\(marker\)/,
  );

  assert.match(styles, /\.operationTableWrap/);
  assert.match(styles, /\.operationTableWrap\s+thead\s+th\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /overflow-x:\s*auto/);
  assert.match(styles, /max-height:\s*3\d\dpx/);
});
