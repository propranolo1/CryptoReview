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
  assert.match(html, /K 线回放/);
  assert.match(html, /导入仓位/);
  assert.match(html, /止盈止损设置/);
  assert.match(html, /回放结果/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("图表保持客户端边界且启动骨架已经移除", async () => {
  const [component, page, layout, packageJson, architecture] = await Promise.all([
    readFile(new URL("../app/components/TradeReplay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../AI_README.md", import.meta.url), "utf8"),
  ]);

  assert.match(component, /^"use client";/);
  assert.match(component, /await import\("lightweight-charts"\)/);
  assert.match(component, /createSeriesMarkers/);
  assert.match(component, /createPriceLine/);
  assert.match(component, /parseTrades/);
  assert.match(component, /calculateTradePnl/);
  assert.match(page, /<TradeReplay \/>/);
  assert.match(layout, /title:\s*"复盘舱 · CryptoReview"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(architecture, /回放时刻/);

  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url)));
  await access(new URL("../AI_README.md", import.meta.url));
});
