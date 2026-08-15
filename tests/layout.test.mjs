import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("K 线使用加高画布，桌面端全部交易在固定侧栏内滚动", async () => {
  const styles = await readFile(new URL("app/globals.css", projectUrl), "utf8");

  assert.match(
    styles,
    /\.chart-area\s*\{[^}]*height:\s*clamp\(680px,\s*76vh,\s*920px\)/s,
  );
  assert.match(
    styles,
    /\.trade-sidebar\s*\{[^}]*height:\s*calc\(100vh\s*-\s*96px\)[^}]*max-height:\s*calc\(100vh\s*-\s*96px\)/s,
  );
  assert.match(
    styles,
    /\.trade-list\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s,
  );
});

test("窄屏恢复自然高度并使用横向交易列表", async () => {
  const styles = await readFile(new URL("app/globals.css", projectUrl), "utf8");
  const narrowScreen = styles.match(/@media \(max-width:\s*930px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(
    narrowScreen,
    /\.trade-sidebar\s*\{[^}]*height:\s*auto[^}]*max-height:\s*none/s,
  );
  assert.match(
    narrowScreen,
    /\.trade-list\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s,
  );
});

test("顶部右侧操作区保留固有宽度，不覆盖交易表现切换按钮", async () => {
  const styles = await readFile(new URL("app/globals.css", projectUrl), "utf8");
  const actions = styles.match(/\.topbar-actions\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(actions, /min-width:\s*max-content/);
  assert.doesNotMatch(actions, /min-width:\s*0/);
});

test("训练模式加入后窄屏主切换使用三列，顶部不再保留冗余状态文字", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(css, /\.storage-status\s*\{/);
  assert.doesNotMatch(css, /\.date-chip\s*\{/);

  const mobile = /@media\s*\(max-width:\s*650px\)\s*\{([\s\S]*)/.exec(css)?.[1] ?? "";
  assert.match(mobile, /\.topbar-center\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
});
