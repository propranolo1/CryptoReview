import assert from "node:assert/strict";
import test from "node:test";

import {
  createOkxClient,
  normalizeOkxAlgoOrders,
  normalizeOkxFill,
  normalizeOkxInstrument,
  normalizeOkxNormalOrder,
  normalizeOkxOpenPosition,
  signOkxRequest,
} from "../desktop/okx-client.mjs";

const ACCOUNT_ID = "okx-v5:local-account";
const BTC_SWAP = {
  instId: "BTC-USDT-SWAP",
  instType: "SWAP",
  ctType: "linear",
  settleCcy: "USDT",
  ctVal: "0.01",
  ctMult: "1",
};

test("OKX 私有请求按 timestamp + method + requestPath + body 生成 Base64 HMAC-SHA256", () => {
  assert.equal(
    signOkxRequest(
      "2020-12-08T09:08:57.715Z",
      "GET",
      "/api/v5/account/balance?ccy=BTC",
      "",
      "my-secret",
    ),
    "K34BJrtr2K5I4Wsbq0di4kM0ZhnsO1XoNOLszVw1w2M=",
  );
});

test("OKX USDT 线性永续元数据把张数按 ctVal × ctMult 转换为基币数量", () => {
  const instrument = normalizeOkxInstrument({
    ...BTC_SWAP,
    ctMult: "2",
  });

  assert.deepEqual(instrument, {
    instId: "BTC-USDT-SWAP",
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    contractValue: 0.01,
    contractMultiplier: 2,
    baseQuantityPerContract: 0.02,
  });
  assert.equal(normalizeOkxInstrument({
    ...BTC_SWAP,
    instId: "BTC-USD-SWAP",
    settleCcy: "BTC",
    ctType: "inverse",
  }), null);
  assert.equal(normalizeOkxInstrument({
    ...BTC_SWAP,
    ctValCcy: "USDT",
  }), null);
});

test("OKX 基础单、成交和持仓统一映射为现有复盘订单结构", () => {
  const instrument = normalizeOkxInstrument(BTC_SWAP);
  const order = normalizeOkxNormalOrder({
    instId: "BTC-USDT-SWAP",
    ordId: "1001",
    ordType: "limit",
    side: "buy",
    posSide: "long",
    px: "60000",
    avgPx: "60100",
    sz: "5",
    accFillSz: "4",
    state: "partially_filled",
    reduceOnly: "false",
    cTime: "1784182961000",
    uTime: "1784187197000",
  }, ACCOUNT_ID, instrument);
  const fill = normalizeOkxFill({
    instId: "BTC-USDT-SWAP",
    billId: "9001",
    tradeId: "501",
    ordId: "1001",
    side: "buy",
    posSide: "long",
    fillPx: "60100",
    fillSz: "2",
    fee: "-0.04808",
    feeCcy: "USDT",
    fillPnl: "0",
    fillTime: "1784187000000",
    execType: "T",
  }, ACCOUNT_ID, instrument);
  const position = normalizeOkxOpenPosition({
    instId: "BTC-USDT-SWAP",
    posSide: "long",
    pos: "4",
    avgPx: "60100",
    bePx: "60112.02",
    markPx: "61000",
    upl: "36",
    ccy: "USDT",
    uTime: "1784187197000",
  }, ACCOUNT_ID, instrument);

  assert.deepEqual(order, {
    userId: ACCOUNT_ID,
    orderId: "1001",
    symbol: "BTCUSDT",
    orderType: "LIMIT",
    side: "BUY",
    limitPrice: 60000,
    averagePrice: 60100,
    originalQuantity: 0.05,
    executedQuantity: 0.04,
    executedQuoteQuantity: 2404,
    stopPrice: null,
    status: "PARTIALLY_FILLED",
    createdAt: "2026-07-16T06:22:41.000Z",
    updatedAt: "2026-07-16T07:33:17.000Z",
    positionSide: "LONG",
    reduceOnly: false,
    closePosition: false,
    workingType: null,
    sourceKind: "okx-api-normal",
    provider: "okx",
    exchangeProvider: "okx-swap",
    instrumentId: "BTC-USDT-SWAP",
  });
  assert.equal(fill.quantity, 0.02);
  assert.equal(fill.quoteQuantity, 1202);
  assert.equal(fill.commission, 0.04808);
  assert.equal(fill.commissionAsset, "USDT");
  assert.equal(fill.maker, false);
  assert.equal(position.quantity, 0.04);
  assert.equal(position.side, "long");
  assert.equal(position.entryPrice, 60100);
  assert.equal(Object.hasOwn(position, "entryTime"), false);
});

test("OKX 手续费负数表示支出、正数表示返佣，统一 commission 保留净费用方向", () => {
  const instrument = normalizeOkxInstrument(BTC_SWAP);
  const rebate = normalizeOkxFill({
    instId: "BTC-USDT-SWAP",
    billId: "9002",
    tradeId: "502",
    ordId: "1002",
    side: "sell",
    posSide: "long",
    fillPx: "61000",
    fillSz: "1",
    fee: "0.01",
    feeCcy: "USDT",
    fillPnl: "9",
    fillTime: "1784188000000",
    execType: "M",
  }, ACCOUNT_ID, instrument);

  assert.equal(rebate.commission, -0.01);
  assert.equal(rebate.realizedPnl, 9);
  assert.equal(rebate.maker, true);
});

test("OKX net 模式负仓映射为空仓，数量取绝对值且字符串 false 不会误判", () => {
  const instrument = normalizeOkxInstrument(BTC_SWAP);
  const order = normalizeOkxNormalOrder({
    instId: "BTC-USDT-SWAP",
    ordId: "1003",
    ordType: "market",
    side: "sell",
    posSide: "net",
    px: "",
    avgPx: "60000",
    sz: "3",
    accFillSz: "3",
    state: "filled",
    reduceOnly: "false",
    cTime: "1784182961000",
    uTime: "1784182961000",
  }, ACCOUNT_ID, instrument);
  const position = normalizeOkxOpenPosition({
    instId: "BTC-USDT-SWAP",
    posSide: "net",
    pos: "-3",
    avgPx: "60000",
    bePx: "",
    markPx: "59000",
    upl: "30",
    ccy: "USDT",
    uTime: "1784187197000",
  }, ACCOUNT_ID, instrument);

  assert.equal(order.reduceOnly, false);
  assert.equal(order.positionSide, "BOTH");
  assert.equal(position.positionSide, "BOTH");
  assert.equal(position.side, "short");
  assert.equal(position.quantity, 0.03);
});

test("OKX 同一 OCO 条件单拆成独立 TP 与 SL，保留 MARKET/LIMIT 和生命周期", () => {
  const instrument = normalizeOkxInstrument(BTC_SWAP);
  const orders = normalizeOkxAlgoOrders({
    instId: "BTC-USDT-SWAP",
    instType: "SWAP",
    algoId: "7001",
    ordType: "oco",
    side: "sell",
    posSide: "long",
    sz: "4",
    state: "effective",
    reduceOnly: "true",
    tpTriggerPx: "65000",
    tpOrdPx: "-1",
    tpTriggerPxType: "mark",
    slTriggerPx: "59000",
    slOrdPx: "58950",
    slTriggerPxType: "last",
    actualSide: "tp",
    triggerTime: "1784189000000",
    cTime: "1784182961000",
  }, ACCOUNT_ID, instrument);

  assert.equal(orders.length, 2);
  assert.deepEqual(
    orders.map((order) => ({
      id: order.orderId,
      type: order.orderType,
      stopPrice: order.stopPrice,
      limitPrice: order.limitPrice,
      status: order.status,
      workingType: order.workingType,
    })),
    [
      {
        id: "okx-algo:7001:tp",
        type: "TAKE_PROFIT_MARKET",
        stopPrice: 65000,
        limitPrice: null,
        status: "FILLED",
        workingType: "MARK_PRICE",
      },
      {
        id: "okx-algo:7001:sl",
        type: "STOP",
        stopPrice: 59000,
        limitPrice: 58950,
        status: "CANCELED",
        workingType: "CONTRACT_PRICE",
      },
    ],
  );
});

test("OKX 凭证验证使用服务器时间和官方签名头，并按账户 uid 建立稳定身份", async () => {
  const requests = [];
  const client = createOkxClient({
    now: () => 1784189000000,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.pathname === "/api/v5/public/time") {
        return Response.json({ code: "0", msg: "", data: [{ ts: "1784189000100" }] });
      }
      if (url.pathname === "/api/v5/account/config") {
        return Response.json({
          code: "0",
          msg: "",
          data: [{ uid: "44705892343619584", mainUid: "44705892343619580" }],
        });
      }
      return Response.json({ code: "51000", msg: "unexpected", data: [] });
    },
  });

  const identity = await client.validateCredentials({
    apiKey: "okx-key",
    apiSecret: "okx-secret",
    passphrase: "okx-passphrase",
    region: "us",
  });

  assert.deepEqual(identity, {
    accountUid: "44705892343619584",
    region: "us",
  });
  assert.equal(requests[0].url.origin, "https://us.okx.com");
  assert.equal(requests[1].init.headers["OK-ACCESS-KEY"], "okx-key");
  assert.equal(requests[1].init.headers["OK-ACCESS-PASSPHRASE"], "okx-passphrase");
  assert.match(requests[1].init.headers["OK-ACCESS-SIGN"], /^[A-Za-z0-9+/]+=*$/);
  assert.equal(requests[1].init.headers["OK-ACCESS-TIMESTAMP"], "2026-07-16T08:03:20.100Z");
});

test("OKX 区域只接受 global、us、eea，并使用对应官方 REST 域名", async () => {
  const origins = [];
  const client = createOkxClient({
    now: () => 1784189000000,
    fetchImpl: async (input) => {
      const url = new URL(input);
      origins.push(url.origin);
      if (url.pathname === "/api/v5/public/time") {
        return Response.json({ code: "0", msg: "", data: [{ ts: "1784189000000" }] });
      }
      return Response.json({
        code: "0",
        msg: "",
        data: [{ uid: `uid-${origins.length}` }],
      });
    },
  });

  for (const region of ["global", "us", "eea"]) {
    await client.validateCredentials({
      apiKey: "okx-key",
      apiSecret: "okx-secret",
      passphrase: "okx-passphrase",
      region,
    });
  }

  assert.deepEqual([...new Set(origins)], [
    "https://openapi.okx.com",
    "https://us.okx.com",
    "https://eea.okx.com",
  ]);
  await assert.rejects(
    () => client.validateCredentials({
      apiKey: "okx-key",
      apiSecret: "okx-secret",
      passphrase: "okx-passphrase",
      region: "unknown",
    }),
    /global、us 或 eea/,
  );
});

test("OKX 同步无需手填交易对，分页读取 USDT SWAP 基础单、成交、条件单与当前持仓", async () => {
  const requests = [];
  const normalOrder = {
    instId: "BTC-USDT-SWAP",
    instType: "SWAP",
    ordId: "1001",
    ordType: "market",
    side: "buy",
    posSide: "long",
    px: "",
    avgPx: "60000",
    sz: "2",
    accFillSz: "2",
    state: "filled",
    reduceOnly: "false",
    cTime: "1784182961000",
    uTime: "1784182961000",
  };
  const client = createOkxClient({
    now: () => 1784189000000,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname === "/api/v5/public/time") {
        return Response.json({ code: "0", msg: "", data: [{ ts: "1784189000000" }] });
      }
      if (url.pathname === "/api/v5/public/instruments") {
        return Response.json({ code: "0", msg: "", data: [
          BTC_SWAP,
          { ...BTC_SWAP, instId: "BTC-USD-SWAP", settleCcy: "BTC", ctType: "inverse" },
        ] });
      }
      if (url.pathname === "/api/v5/trade/orders-history-archive") {
        return Response.json({ code: "0", msg: "", data: [normalOrder] });
      }
      if (url.pathname === "/api/v5/trade/fills-history") {
        return Response.json({ code: "0", msg: "", data: [{
          instId: "BTC-USDT-SWAP",
          instType: "SWAP",
          billId: "9001",
          tradeId: "501",
          ordId: "1001",
          side: "buy",
          posSide: "long",
          fillPx: "60000",
          fillSz: "2",
          fee: "-0.048",
          feeCcy: "USDT",
          fillPnl: "0",
          fillTime: "1784182961000",
          execType: "T",
        }] });
      }
      if (url.pathname === "/api/v5/account/positions") {
        return Response.json({ code: "0", msg: "", data: [{
          instId: "BTC-USDT-SWAP",
          instType: "SWAP",
          posSide: "long",
          pos: "2",
          avgPx: "60000",
          bePx: "60024",
          markPx: "61000",
          upl: "20",
          ccy: "USDT",
          uTime: "1784187197000",
        }] });
      }
      if (url.pathname === "/api/v5/trade/orders-algo-pending" &&
          url.searchParams.get("ordType") === "conditional") {
        return Response.json({ code: "0", msg: "", data: [{
          instId: "BTC-USDT-SWAP",
          instType: "SWAP",
          algoId: "7001",
          ordType: "conditional",
          side: "sell",
          posSide: "long",
          sz: "2",
          state: "live",
          reduceOnly: "true",
          slTriggerPx: "59000",
          slOrdPx: "-1",
          slTriggerPxType: "mark",
          cTime: "1784185000000",
          triggerTime: "",
        }] });
      }
      return Response.json({ code: "0", msg: "", data: [] });
    },
  });

  const result = await client.syncOrders({
    apiKey: "okx-key",
    apiSecret: "okx-secret",
    passphrase: "okx-passphrase",
    region: "global",
    accountId: ACCOUNT_ID,
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(result.symbols, ["BTCUSDT"]);
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.equal(result.normalOrderCount, 1);
  assert.equal(result.algoOrderCount, 1);
  assert.equal(result.fillCount, 1);
  assert.equal(result.openPositionCount, 1);
  assert.equal(result.orders.find((order) => order.orderId === "1001").fills.length, 1);
  assert.equal(result.orders.find((order) => order.orderId === "okx-algo:7001:sl").stopPrice, 59000);
  assert.equal(requests.some((url) => url.pathname === "/api/v5/trade/orders-pending"), true);
  assert.equal(requests.some((url) => url.pathname === "/api/v5/trade/orders-history"), true);
  assert.equal(requests.some((url) => url.pathname === "/api/v5/trade/orders-history-archive"), true);
  assert.equal(requests.some((url) => url.pathname === "/api/v5/trade/fills-history"), true);
  assert.equal(requests.some((url) => url.pathname === "/api/v5/account/positions"), true);
  assert.equal(
    requests.some((url) =>
      url.pathname === "/api/v5/trade/orders-algo-history" &&
      url.searchParams.get("state") === "partially_failed"
    ),
    true,
  );
  assert.equal(requests.some((url) => url.searchParams.has("symbol")), false);
});

test("OKX 游标分页使用 ordId、billId 与 algoId，服务端限流后重新签名重试", async () => {
  let archiveAttempts = 0;
  const delays = [];
  const cursors = [];
  const pageOf = (count, idField, prefix) => Array.from({ length: count }, (_, index) => ({
    [idField]: `${prefix}${String(count - index).padStart(3, "0")}`,
  }));
  const client = createOkxClient({
    now: () => 1784189000000,
    sleep: async (delay) => delays.push(delay),
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/v5/public/time") {
        return Response.json({ code: "0", msg: "", data: [{ ts: "1784189000000" }] });
      }
      if (url.pathname === "/api/v5/public/instruments") {
        return Response.json({ code: "0", msg: "", data: [BTC_SWAP] });
      }
      if (url.pathname === "/api/v5/trade/orders-history-archive") {
        archiveAttempts += 1;
        cursors.push(["order", url.searchParams.get("after")]);
        if (archiveAttempts === 1) {
          return Response.json({ code: "50011", msg: "Rate limit reached", data: [] });
        }
        return Response.json({
          code: "0",
          msg: "",
          data: url.searchParams.has("after") ? [] : pageOf(100, "ordId", "o"),
        });
      }
      if (url.pathname === "/api/v5/trade/fills-history") {
        cursors.push(["fill", url.searchParams.get("after")]);
        return Response.json({
          code: "0",
          msg: "",
          data: url.searchParams.has("after") ? [] : pageOf(100, "billId", "b"),
        });
      }
      if (url.pathname === "/api/v5/trade/orders-algo-pending" &&
          url.searchParams.get("ordType") === "conditional") {
        cursors.push(["algo", url.searchParams.get("after")]);
        return Response.json({
          code: "0",
          msg: "",
          data: url.searchParams.has("after") ? [] : pageOf(100, "algoId", "a"),
        });
      }
      return Response.json({ code: "0", msg: "", data: [] });
    },
  });

  await client.syncOrders({
    apiKey: "okx-key",
    apiSecret: "okx-secret",
    passphrase: "okx-passphrase",
    accountId: ACCOUNT_ID,
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.equal(archiveAttempts, 3);
  assert.equal(cursors.some(([kind, cursor]) => kind === "order" && cursor === "o001"), true);
  assert.equal(cursors.some(([kind, cursor]) => kind === "fill" && cursor === "b001"), true);
  assert.equal(cursors.some(([kind, cursor]) => kind === "algo" && cursor === "a001"), true);
  assert.equal(delays.length, 1);
});

test("OKX 独立端点使用有限并发、复用合约元数据并报告进度", async () => {
  const now = 1784189000000;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let instrumentRequests = 0;
  const progress = [];
  const client = createOkxClient({
    now: () => now,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/v5/public/time") {
        return Response.json({ code: "0", msg: "", data: [{ ts: String(now) }] });
      }
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 4));
      activeRequests -= 1;
      if (url.pathname === "/api/v5/public/instruments") {
        instrumentRequests += 1;
        return Response.json({ code: "0", msg: "", data: [BTC_SWAP] });
      }
      return Response.json({ code: "0", msg: "", data: [] });
    },
  });
  const input = {
    apiKey: "synthetic-key",
    apiSecret: "synthetic-secret",
    passphrase: "synthetic-passphrase",
    region: "global",
    accountId: ACCOUNT_ID,
    startTime: now - 86_400_000,
    endTime: now,
    onProgress: (value) => progress.push(value),
  };

  await client.syncOrders(input);
  await client.syncOrders(input);

  assert.equal(maxActiveRequests > 1, true);
  assert.equal(maxActiveRequests <= 4, true);
  assert.equal(instrumentRequests, 1);
  assert.equal(progress.some((item) => item.stage === "complete"), true);
});
