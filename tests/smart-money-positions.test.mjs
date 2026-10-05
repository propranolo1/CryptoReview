import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import * as domain from '../lib/smart-money-positions.mjs';
import { normalizeTradeProfiles } from '../lib/trade-profiles.mjs';
import { createDesktopRepository } from '../desktop/database.mjs';

const topTraderId = '1234567890123456789';
const fetchedAt = '2026-10-05T04:00:00.000Z';
const position = (symbol = 'DOODUSDT', quantity = 50, positionSide = 'LONG') => ({ symbol, quantity, positionSide, entryPrice: 0.02 });
const profile = (positions = [position()]) => ({ id: 'profile-synthetic', name: '合成持仓测试', createdAt: fetchedAt,
  smartMoneySource: { topTraderId, sourceUrl: `https://www.binance.com/zh-CN/smart-money/profile/${topTraderId}`,
    leadPortfolioId: null, orderIdentity: topTraderId, enabled: true, intervalSeconds: 60,
    sharingPosition: true, sharingLatestRecord: true, lastSnapshot: { fetchedAt, positions } } });
const replay = (p = position(), extra = {}) => ({ profileId: 'profile-synthetic', symbol: p.symbol,
  openPosition: { ...p, userId: `smart-money:${topTraderId}`, syncedAt: fetchedAt }, ...extra });

test('仓位已读到但没有完整复盘时仍提供真实数量与均价，不伪造交易字段', () => {
  const input = profile([position(), position('NAORISUSDT', 70)]);
  const before = structuredClone(input);
  const result = domain.getUnreplayedSmartMoneyPositions(input, []);
  assert.equal(result.positions.length, 2);
  assert.deepEqual(result.positions[0], position());
  assert.equal(result.fetchedAt, fetchedAt);
  for (const item of result.positions) {
    for (const field of ['entryTime', 'entries', 'exits', 'fee', 'pnl', 'markPrice']) assert.equal(field in item, false);
  }
  assert.deepEqual(input, before);
});

test('仅同用户同来源同持仓方向且数量吻合的新复盘可覆盖仓位，旧复盘不能隐藏缺口', () => {
  const input = profile();
  assert.equal(domain.getUnreplayedSmartMoneyPositions(input, [replay()]), null);
  const wrong = [
    replay(position(), { profileId: 'another-profile' }),
    replay(position('DOODUSDT', 20)),
    replay(position('DOODUSDT', 50, 'SHORT')),
    replay(position(), { openPosition: { ...replay().openPosition, userId: 'another-source' } }),
    replay(position(), { openPosition: { ...replay().openPosition, syncedAt: '2026-10-01T00:00:00Z' } }),
    { profileId: input.id, symbol: 'DOODUSDT', exits: [{ quantity: 50 }] },
  ];
  assert.equal(domain.getUnreplayedSmartMoneyPositions(input, wrong).positions.length, 1);
  assert.equal(domain.getUnreplayedSmartMoneyPositions(input, [replay(position('DOODUSDT', 50 + 1e-10))]), null);
});

test('补齐历史后仓位提示消失，最新空仓快照移除旧持仓，不影响已有复盘数组', () => {
  const trades = [replay()]; const before = structuredClone(trades);
  assert.equal(domain.getUnreplayedSmartMoneyPositions(profile(), trades), null);
  assert.equal(domain.getUnreplayedSmartMoneyPositions(profile([]), []), null);
  assert.deepEqual(trades, before);
});

test('来源解除、切换用户或无有效快照时不泄漏上一个用户的持仓', () => {
  assert.equal(domain.getUnreplayedSmartMoneyPositions({ id: 'profile-self' }, []), null);
  assert.equal(domain.getUnreplayedSmartMoneyPositions(null, []), null);
  const invalid = profile(); invalid.smartMoneySource.lastSnapshot.fetchedAt = 'bad';
  assert.equal(domain.getUnreplayedSmartMoneyPositions(invalid, []), null);
  assert.equal(domain.getUnreplayedSmartMoneyPositions(profile([position('DOODUSDT', 0)]), []), null);
});

test('SQLite 重启恢复快照后仍可展示，暂停更新和同步失败不会丢失最近持仓', () => {
  const repository = createDesktopRepository(':memory:');
  try {
    const input = profile(); input.smartMoneySource.enabled = false; input.smartMoneySource.lastError = '合成网络错误';
    repository.saveProfiles(normalizeTradeProfiles([input]));
    const restored = normalizeTradeProfiles(repository.loadState().profiles).find(item => item.id === input.id);
    assert.deepEqual(domain.getUnreplayedSmartMoneyPositions(restored, []).positions, [position()]);
  } finally { repository.close(); }
});

async function component() {
  const source = await readFile(new URL('../app/components/SmartMoneyPositions.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === '@/lib/smart-money-positions.mjs') return domain;
    throw new Error(`非预期组件依赖：${name}`);
  }, exports);
  return exports.SmartMoneyPositions;
}

test('真实组件展示缺失仓位和历史不完整，提供数量、开仓均价、同步时间且不提供交易操作', async () => {
  const Component = await component();
  const html = renderToStaticMarkup(Component({ profile: profile(), trades: [] }));
  for (const text of ['DOOD/USDT', '历史不完整', '持仓数量', '50', '开仓均价', '0.02', '最近同步', '暂不能回放']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<button|data-preview-trade-id|盈亏金额|入场时间/);
  assert.equal(renderToStaticMarkup(Component({ profile: profile(), trades: [replay()] })), '');
});

test('旧单向快照缺少多空信息时不猜方向，同步失败仍标明为上次成功的数据', async () => {
  const Component = await component(); const input = profile([position('BTCUSDT', 1, 'BOTH')]);
  input.smartMoneySource.lastError = '合成错误';
  const html = renderToStaticMarkup(Component({ profile: input, trades: [] }));
  assert.ok(html.includes('方向未知'));
  assert.ok(html.includes('更新未成功'));
  assert.ok(html.includes(fetchedAt));
});

test('真实复盘入口在有交易与零复盘两条分支均接入持仓展示', async () => {
  const source = await readFile(new URL('../app/components/TradeReplay.tsx', import.meta.url), 'utf8');
  const matches = [...source.matchAll(/<SmartMoneyPositions\s+profile=\{activeProfile\}\s+trades=\{activeProfileTrades\}\s*\/>/g)];
  assert.equal(matches.length, 2);
  const empty = source.indexOf('className="profile-empty-workspace"');
  const sidebar = source.indexOf('<aside className={`trade-sidebar');
  assert.ok(matches[0].index > empty && matches[0].index < sidebar);
  assert.ok(matches[1].index > sidebar);
});
