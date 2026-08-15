import assert from "node:assert/strict";
import test from "node:test";

import { reconstructBinanceUsdmReplays } from "../lib/binance-orders.mjs";
import {
  createFollowTradeOrderRecords,
  parseFollowTradeTimelineText,
} from "../lib/follow-trade-records.mjs";
import { XIAOHONG_TRADE_PROFILE_ID } from "../lib/trade-profiles.mjs";

const screenshotText = `
2026-07-17 18:58 平多
以均价为1,413.11关闭做多SNDKUSDT USDT仓位，成交数量为1.91SNDK，总价值为2,699.0401USDT。已实现盈亏为13.04597787USDT。
2026-07-17 18:39 平多
以均价为1,191.5关闭做多SKHYNIXUSDT USDT仓位，成交数量为5.44SKHYNIX，总价值为6,481.76USDT。已实现盈亏为-5.8675866USDT。
2026-07-17 18:16 平多
以均价为1,190.28647关闭做多SKHYNIXUSDT USDT仓位，成交数量为2.92SKHYNIX，总价值为3,475.63649999USDT。已实现盈亏为-6.69301333USDT。
2026-07-17 18:11 平多
以均价为1,419.48关闭做多SNDKUSDT USDT仓位，成交数量为0.97SNDK，总价值为1,376.8956USDT。已实现盈亏为12.80434424USDT。
2026-07-17 18:09 平多
以均价为1,412.46454关闭做多SNDKUSDT USDT仓位，成交数量为6.70SNDK，总价值为9,463.51239991USDT。已实现盈亏为41.43877785USDT。
2026-07-17 13:03 开多
以均价为1,170.83开启做多SKHYNIXUSDT USDT仓位，成交数量为1.70SKHYNIX，总价值为1,990.411USDT。
2026-07-17 13:02 开多
以均价为1,362.90645开启做多SNDKUSDT USDT仓位，成交数量为1.10SNDK，总价值为1,499.19709995USDT。
`;

test("跟单时间线文本可识别开多和平多的价格、数量与截图盈亏", () => {
  const events = parseFollowTradeTimelineText(screenshotText);

  assert.equal(events.length, 7);
  assert.deepEqual(
    {
      time: events[0].time,
      action: events[0].action,
      symbol: events[0].symbol,
      price: events[0].price,
      quantity: events[0].quantity,
      quoteQuantity: events[0].quoteQuantity,
      realizedPnl: events[0].realizedPnl,
    },
    {
      time: "2026-07-17T05:02:00.000Z",
      action: "openLong",
      symbol: "SNDKUSDT",
      price: 1362.90645,
      quantity: 1.1,
      quoteQuantity: 1499.19709995,
      realizedPnl: null,
    },
  );
  const last = events.at(-1);
  assert.equal(last.action, "closeLong");
  assert.equal(last.realizedPnl, 13.04597787);
});

test("截图事件转换为小洪名下的稳定订单，重复识别不会增加副本", () => {
  const [event] = parseFollowTradeTimelineText(`
    2026-07-17 13:02 开多
    以均价为1,362.90645开启做多SNDKUSDT USDT仓位，成交数量为1.10SNDK，总价值为1,499.19709995USDT。
  `);
  const first = createFollowTradeOrderRecords([event], {
    profileId: XIAOHONG_TRADE_PROFILE_ID,
    profileName: "小洪",
  });
  const second = createFollowTradeOrderRecords([event], {
    profileId: XIAOHONG_TRADE_PROFILE_ID,
    profileName: "小洪",
  });

  assert.deepEqual(second, first);
  assert.equal(first[0].profileId, XIAOHONG_TRADE_PROFILE_ID);
  assert.equal(first[0].profileName, "小洪");
  assert.equal(first[0].positionSide, "LONG");
  assert.equal(first[0].side, "BUY");
  assert.deepEqual(first[0].syncSources, ["ocr-follow"]);
});

test("完整的跟单开平仓可重建为当前用户独立复盘并保留截图盈亏", () => {
  const events = parseFollowTradeTimelineText(`
    2026-07-17 13:02 开多
    以均价为1,362.90645开启做多SNDKUSDT USDT仓位，成交数量为1.10SNDK，总价值为1,499.19709995USDT。
    2026-07-17 18:09 平多
    以均价为1,412.46454关闭做多SNDKUSDT USDT仓位，成交数量为1.10SNDK，总价值为1,553.711USDT。已实现盈亏为54.514899USDT。
  `);
  const orders = createFollowTradeOrderRecords(events, {
    profileId: XIAOHONG_TRADE_PROFILE_ID,
    profileName: "小洪",
  });
  const reconstruction = reconstructBinanceUsdmReplays(orders);

  assert.equal(reconstruction.warnings.length, 0);
  assert.equal(reconstruction.trades.length, 1);
  assert.equal(reconstruction.trades[0].profileId, XIAOHONG_TRADE_PROFILE_ID);
  assert.equal(reconstruction.trades[0].profileName, "小洪");
  assert.equal(reconstruction.trades[0].strategy, "跟单记录截图重建");
  assert.deepEqual(reconstruction.trades[0].syncSources, ["ocr-follow"]);
  assert.equal(reconstruction.trades[0].reportedRealizedPnl, 54.514899);
});
