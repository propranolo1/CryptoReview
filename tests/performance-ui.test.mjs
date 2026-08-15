import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("交易表现展示已平仓手续费统计，手续费缺失提示不受未平仓交易影响", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/PerformanceOverview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PerformanceOverview.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /<span>手续费<\/span>/);
  assert.match(component, /performance\.totalFees/);
  assert.match(component, /performance\.unknownFeeTrades\s*>\s*0/);
  assert.doesNotMatch(component, /trades\.some\(\(trade\) => trade\.feesKnown === false\)/);
  assert.match(styles, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
});

test("累计盈利与每日盈利使用可稳定命中的显式悬停提示", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/PerformanceOverview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PerformanceOverview.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /curveTooltip/);
  assert.match(component, /dailyTooltip/);
  assert.match(component, /onMouseEnter/);
  assert.match(component, /onMouseLeave/);
  assert.match(component, /onFocus/);
  assert.match(component, /onBlur/);
  assert.match(component, /tabIndex=\{0\}/);
  assert.match(component, /role="tooltip"/);
  assert.match(component, /单笔盈亏/);
  assert.match(component, /累计盈亏/);
  assert.match(component, /当日盈亏/);
  assert.match(styles, /\.chartHitArea/);
  assert.match(styles, /\.chartTooltip/);
  assert.match(styles, /pointer-events:\s*none/);
});

test("交易表现新增直接显示每日金额的盈利日历", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/components/PerformanceOverview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PerformanceOverview.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /每日盈利日历/);
  assert.match(component, /buildDailyPerformanceCalendar/);
  assert.match(component, /formatCalendarMoney/);
  assert.match(component, /calendarMonths/);
  assert.match(component, /calendarDay/);
  assert.match(component, /当日盈亏/);
  assert.match(styles, /\.calendarMonths/);
  assert.match(styles, /\.calendarGrid/);
  assert.match(styles, /\.calendarDay/);
  assert.match(styles, /grid-template-columns:\s*repeat\(7,/);
});
