import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("服务端输出交易复盘工作台的首屏内容", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>复盘舱 · CryptoReview<\/title>/i);
  assert.match(html, /复盘舱/);
  assert.match(html, /HYPE\/USDT/);
  assert.doesNotMatch(html, /K 线回放/);
  assert.match(html, /交易回放/);
  assert.match(html, /交易表现/);
  assert.match(html, /成本/);
  assert.match(html, /导入记录/);
  assert.match(html, /Binance U 本位订单历史/);
  assert.doesNotMatch(html, /止盈止损设置/);
  assert.doesNotMatch(html, /挂单变动记录/);
  assert.doesNotMatch(html, /回放结果/);
  assert.match(html, /当前盈亏/);
  assert.doesNotMatch(html, /累计盈利曲线|每日盈利柱图/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("图表保持客户端边界且启动骨架已经移除", async () => {
  const [component, page, layout, packageJson, architecture, desktopTypes] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../AI_README.md", import.meta.url), "utf8"),
    readFile(new URL("../app/desktop-api.d.ts", import.meta.url), "utf8"),
  ]);

  assert.match(component, /^"use client";/);
  assert.match(component, /await import\("lightweight-charts"\)/);
  assert.match(component, /createSeriesMarkers/);
  assert.match(component, /createPriceLine/);
  assert.match(component, /buildPartialCandle/);
  assert.match(component, /advanceReplayFrame/);
  assert.match(component, /createSettlementTrade/);
  assert.match(component, /createHypeScreenshotTrade/);
  assert.match(component, /getReplayPriceLines/);
  assert.match(component, /mergeDefaultAndImportedTrades/);
  assert.match(component, /parseBinanceUsdmOrderHistoryCsv/);
  assert.match(component, /reconstructBinanceUsdmReplays/);
  assert.match(component, /mergeBinanceOrderRecords/);
  assert.match(component, /cryptoreview-binance-orders-v1/);
  assert.match(component, /replay-toolbar-pnl/);
  assert.doesNotMatch(component, /<aside className="review-sidebar">/);
  assert.match(component, /window\.cryptoReviewDesktop/);
  assert.match(component, /mergeDesktopAndBrowserTrades/);
  assert.match(component, /desktopApi\.saveOrders/);
  assert.match(component, /desktopApi\.saveTrades/);
  assert.doesNotMatch(component, /订单、复盘与训练成绩已保存至本机 SQLite/);
  assert.match(component, /parseTrades/);
  assert.match(component, /calculateTradePnl/);
  assert.match(page, /<TradeReplay \/>/);
  assert.match(layout, /title:\s*"复盘舱 · CryptoReview"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(architecture, /回放时刻/);
  assert.match(desktopTypes, /getInfo\(\): Promise<CryptoReviewDesktopInfo>/);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url)));
  await access(new URL("../AI_README.md", import.meta.url));
});

test("交易切换、平仓日期筛选与独立表现模块均保留回归锚点", async () => {
  const [component, performance, performanceStyles, globals] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PerformanceOverview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PerformanceOverview.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /groupTradesByCloseDate/);
  assert.match(component, /filterTradesByCloseDate/);
  assert.match(component, /getTradeCloseTime/);
  assert.match(component, /selectedDate/);
  assert.match(component, /activeModule/);
  assert.match(component, /交易回放/);
  assert.match(component, /交易表现/);
  assert.match(component, /aria-label="主功能切换"/);
  assert.match(component, /activeModule === "replay"/);
  assert.match(component, /<PerformanceOverview trades=\{archiveTrades\} selectedDate=\{null\} \/>/);
  assert.doesNotMatch(component, /<PerformanceOverview trades=\{archiveTrades\} selectedDate=\{selectedDate\} \/>/);
  assert.equal(component.match(/<PerformanceOverview\b/g)?.length, 1);
  assert.match(component, /<CandleReplayChart\s+key=\{`\$\{trade\.id\}:\$\{frame\}:/);
  assert.match(component, /setCandles\(\[\]\)/);
  assert.match(component, /entryIsBuy\s*=\s*trade\.side === "long"/);
  assert.match(component, /position:\s*entryIsBuy \? "belowBar" : "aboveBar"/);
  assert.match(component, /exitIsBuy\s*=\s*trade\.side === "short"/);
  assert.match(component, /position:\s*exitIsBuy \? "belowBar" : "aboveBar"/);
  assert.doesNotMatch(component, /position:\s*"atPriceMiddle"/);
  assert.doesNotMatch(component, /price:\s*trade\.entryPrice/);
  assert.doesNotMatch(component, /price:\s*exit\.exitPrice/);
  assert.match(component, /lineStyle:\s*2/);
  assert.match(component, /HistogramSeries/);
  assert.match(component, /LineSeries/);
  assert.match(component, /getReplayVolume/);
  assert.match(component, /getReplayOpenInterestPoints/);
  assert.match(component, /成交量/);
  assert.match(component, /OI/);
  assert.match(component, /\/api\/market\/open-interest/);
  assert.match(component, /buildReplayEmaSeries/);
  assert.match(component, /EMA21/);
  assert.match(component, /EMA200/);
  assert.match(component, /LineStyle\.Dotted/);
  assert.match(component, /upColor:\s*"transparent"/);
  assert.match(component, /const chartBackground = "#ffffff"/);
  assert.match(component, /const candleColor = "#111111"/);
  assert.match(component, /downColor:\s*candleColor/);
  assert.match(component, /EMA_WARMUP_CANDLES\s*=\s*280/);
  assert.match(component, /entryMs - intervalMs \* EMA_WARMUP_CANDLES/);
  assert.match(component, /ema21SeriesRef/);
  assert.match(component, /ema200SeriesRef/);
  assert.match(component, /ema21Series\?\.setData/);
  assert.match(component, /ema200Series\?\.setData/);
  assert.match(component, /ema21Series\?\.update/);
  assert.match(component, /ema200Series\?\.update/);
  assert.match(component, /buildReplayOrderFlowSeries/);
  assert.match(component, /指标显示/);
  assert.match(component, /成交量染色/);
  assert.match(component, /RVOL 周期/);
  assert.match(component, /最高\/最低回看/);
  assert.match(component, /buildVolumeCandleColorSeries/);
  assert.match(component, /getReplayVolume\(candles\[safeCursor\]\.volume, candlePhase\)/);
  assert.match(component, /borderColor:\s*"#111111"/);
  assert.match(component, /wickColor:\s*"#111111"/);
  assert.match(component, /夜间模式/);
  assert.match(component, /theme-\$\{appTheme\}/);
  assert.match(component, /useState<AppTheme>\("dark"\)/);
  assert.doesNotMatch(component, /chartTheme|chart-night/);
  assert.match(component, /Delta/);
  assert.match(component, /CVD/);
  assert.match(component, /indicatorVisibility/);
  assert.match(component, /xinMentorship/);
  assert.match(component, /XIN Mentorship/);
  assert.match(component, /buildReplayXinMentorshipSeries/);
  assert.match(component, /xinWt1SeriesRef/);
  assert.match(component, /xinMomentumSeriesRef/);
  assert.doesNotMatch(component, /xin-backtest-panel/);
  assert.match(component, /nextEntryIndex - CHART_PRE_ENTRY_CANDLES/);
  assert.match(component, /rgba\(48, 196, 135, 0\.58\)/);
  assert.match(component, /rgba\(239, 101, 114, 0\.58\)/);

  assert.match(performance, /calculateTradePerformance/);
  assert.match(performance, /累计盈利曲线/);
  assert.match(performance, /每日盈利/);
  assert.match(performance, /胜率/);
  assert.match(performance, /盈亏比/);
  assert.match(performance, /<svg/);
  assert.match(performance, /<title\b/);
  assert.match(performance, /<desc\b/);
  assert.match(performanceStyles, /@media/);
  assert.match(globals, /repeating-linear-gradient\(90deg/);
  assert.match(globals, /\.module-switch/);
  assert.match(globals, /\.performance-workspace/);
  assert.match(globals, /\.replay-app\.theme-light/);
  assert.match(globals, /\.chart-area\s*\{[^}]*background:\s*#(?:fff|ffffff)/s);
});

test("条件单截图在本机 OCR 校对后写入回放，并显示 TP/SL 与执行方式", async () => {
  const [component, importer, ocrRunner, risk] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ConditionOrderImport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/condition-order-ocr.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/risk.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(component, /<ConditionOrderImport/);
  assert.match(component, /attachConditionOrdersToTrades/);
  assert.match(importer, /识别条件单/);
  assert.match(importer, /OCR 条件单校对/);
  assert.match(importer, /图片仅在本机识别，不会上传/);
  assert.match(importer, /TP/);
  assert.match(importer, /SL/);
  assert.match(importer, /MARKET/);
  assert.match(importer, /LIMIT/);
  assert.match(ocrRunner, /OCR_WORKER_PATH\s*=\s*"\/ocr\/worker\.min\.js"/);
  assert.match(ocrRunner, /OCR_CORE_PATH\s*=\s*"\/ocr\/core"/);
  assert.match(ocrRunner, /OCR_LANGUAGE_PATH\s*=\s*"\/ocr\/lang"/);
  assert.match(ocrRunner, /PSM\.SPARSE_TEXT/);
  assert.match(risk, /executionType === "market"/);
  assert.match(risk, /executionType === "limit"/);
  assert.match(risk, /\$\{base\} · MARKET/);
  assert.match(risk, /\$\{base\} · LIMIT/);
});

test("基础单截图使用独立 OCR 入口，保存订单后重建交易复盘", async () => {
  const [component, importer, ocrRunner] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/BasicOrderImport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/basic-order-ocr.ts", import.meta.url), "utf8"),
  ]);

  assert.match(component, /<BasicOrderImport/);
  assert.match(component, /handleBasicOrdersConfirm/);
  assert.match(component, /mergeBinanceOrderRecords/);
  assert.match(component, /reconstructBinanceUsdmReplays/);
  assert.match(importer, /识别基础单/);
  assert.match(importer, /OCR 基础单校对/);
  assert.match(importer, /成交时间采用委托时间近似/);
  assert.match(importer, /开多/);
  assert.match(importer, /平多/);
  assert.match(importer, /开空/);
  assert.match(importer, /平空/);
  assert.match(ocrRunner, /parseBasicOrdersFromOcrWords/);
  assert.match(ocrRunner, /PSM\.SINGLE_LINE/);
  assert.match(ocrRunner, /recoverBasicOrderFields/);
});

test("顶部将订单记录与两类 OCR 收纳到统一导入菜单", async () => {
  const [component, globals] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /<details className="import-menu">/);
  assert.match(component, /<summary className="import-button"/);
  assert.match(component, /aria-label="导入方式"/);
  assert.match(component, /<BasicOrderImport/);
  assert.match(component, /<ConditionOrderImport/);
  assert.match(component, /导入记录/);
  assert.match(globals, /\.import-menu-panel/);
  assert.doesNotMatch(globals, /\.date-chip\s*\{/);
});

test("顶部、训练页眉与回放图表不再显示红框中的冗余文字", async () => {
  const [replay, training, api] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TrainingMode.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/BinanceApiConnect.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(replay, /className="brand-name"/);
  assert.doesNotMatch(replay, /className="brand-subtitle"/);
  assert.doesNotMatch(replay, /className="storage-status"/);
  assert.doesNotMatch(replay, /className="date-chip"/);
  assert.doesNotMatch(replay, /<span>\{appTheme === "dark" \? "日间模式" : "夜间模式"\}<\/span>/);
  assert.doesNotMatch(replay, /<span className=\{`source-chip/);
  assert.match(replay, /aria-label="打开导入菜单"/);
  assert.doesNotMatch(replay, /<FileUp size=\{15\} \/>\s*导入/);

  assert.doesNotMatch(training, /BTCUSDT · Binance Futures/);
  assert.doesNotMatch(training, /随机历史片段逐根揭示，未来行情已隐藏。/);

  assert.match(api, /aria-label="连接交易所 API"/);
  assert.match(api, /aria-label="更新已连接交易所数据"/);
  assert.doesNotMatch(api, /<span>交易所 API<\/span>/);
  assert.doesNotMatch(api, /<span>\{busy === "quick-sync" \? "更新中" : "更新"\}<\/span>/);
});

test("同步来源与操作提示都嵌入现有交易卡片和回放进度条", async () => {
  const [component, globals] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /buildReplayProgressNodes/);
  assert.match(component, /getReplaySourceDisplay/);
  assert.match(component, /className="trade-source-badge"/);
  assert.match(component, /className="replay-progress-track"/);
  assert.match(component, /className="replay-progress-events"/);
  assert.match(component, /className="replay-progress-tooltip" role="tooltip"/);
  assert.match(component, /tabIndex=\{0\}/);
  assert.match(globals, /\.replay-progress-event:hover\s+\.replay-progress-tooltip/s);
  assert.match(globals, /\.replay-progress-event:focus-visible\s+\.replay-progress-tooltip/s);
  assert.doesNotMatch(component, /operation-timeline-card|replay-operation-panel/);
});

test("交易回放在 K 线前持续显示无未来数据的分段仓位比例条", async () => {
  const [component, globals] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /buildReplayPositionState/);
  assert.match(
    component,
    /buildReplayPositionState\(\s*trade,\s*currentReplayTimeMs \?\? Number\.NEGATIVE_INFINITY/s,
  );
  assert.match(
    component,
    /className=\{`position-ratio-strip \$\{trade\.side\}`\}[\s\S]*className="chart-area"/,
  );
  assert.match(component, />当前仓位</);
  assert.match(component, /相对截至当前的最大持仓/);
  assert.match(component, /空仓 · 0/);
  assert.match(component, /满仓 · 1\/1/);
  assert.match(component, /\$\{positionState\.label\} · \$\{positionPercent\}%/);
  assert.match(component, /segment\.ratio \* 100/);
  assert.match(component, /segment\.isAddition \? "addition" : "base"/);
  assert.match(component, /segment\.colorIndex % 4/);
  assert.match(component, /role="progressbar"/);
  assert.match(component, /aria-valuetext=\{positionDisplay\}/);

  assert.match(globals, /\.position-ratio-strip\s*\{/);
  assert.match(globals, /\.position-ratio-track\s*\{/);
  assert.match(globals, /\.position-ratio-segment\s*\{/);
  assert.match(globals, /\.position-ratio-strip\.long\s+\.position-color-0/);
  assert.match(globals, /\.position-ratio-strip\.short\s+\.position-color-0/);
  assert.match(
    globals,
    /@media \(max-width: 650px\)[\s\S]*\.position-ratio-strip\s*\{/,
  );
});

test("分批加仓只在成交后更新 BUY SELL 箭头、成本线与实时盈亏", async () => {
  const component = await readFile(
    new URL("../app/components/TradeReplay.tsx", import.meta.url),
    "utf8",
  );

  assert.match(component, /buildReplayTradeSnapshot/);
  assert.match(
    component,
    /buildReplayTradeSnapshot\(\s*trade,\s*replayTimeMs,\s*currentCandle\.close,?\s*\)/s,
  );
  assert.match(component, /replaySnapshot\.visibleEntries\.forEach/);
  assert.match(component, /entry\.entryTime/);
  assert.match(component, /id:\s*`entry-\$\{trade\.id\}-\$\{index\}`/);
  assert.doesNotMatch(
    component,
    /if \(safeCursor >= entryIndex && candles\[entryIndex\]\)/,
  );
  assert.match(
    component,
    /entryPrice:\s*replaySnapshot\.averageEntryPrice/,
  );
  assert.match(
    component,
    /buildReplayTradeSnapshot\(\s*trade,\s*currentReplayTimeMs \?\? Number\.NEGATIVE_INFINITY,\s*currentCandle\?\.close,?\s*\)/s,
  );
  assert.match(component, /const visibleExits = replaySnapshot\.visibleExits/);
  assert.match(component, /const pnl = replaySnapshot\.pnl \?\? EMPTY_PNL/);
  assert.match(component, /formatMoney\(pnl\.totalPnl, true\)/);
  assert.match(component, /formatPercent\(pnl\.returnRatePercent, true\)/);
  assert.doesNotMatch(
    component,
    /trade\.fee \+ visibleExits\.reduce\(\(sum, exit\) => sum \+ exit\.fee, 0\)/,
  );
  assert.doesNotMatch(component, /function replayPnl\(/);
  assert.match(component, /currentAverageEntryPrice/);
});
