import assert from "node:assert/strict";
import test from "node:test";

import {
  createBinanceUsdmClient,
  normalizeAlgoOrder,
  normalizeFundingFee,
  normalizeNormalOrder,
  normalizeOpenPosition,
  normalizeUserTrade,
  signBinanceQuery,
} from "../desktop/binance-usdm-client.mjs";

test("Binance 资金费流水保留正负金额、资产与发生时间", () => {
  assert.deepEqual(normalizeFundingFee({
    symbol: "BTCUSDT",
    incomeType: "FUNDING_FEE",
    income: "-0.75",
    asset: "USDT",
    time: 1784185000000,
    tranId: 9001,
  }, "local-account"), {
    userId: "local-account",
    transactionId: "9001",
    symbol: "BTCUSDT",
    incomeType: "FUNDING_FEE",
    amount: -0.75,
    asset: "USDT",
    time: "2026-07-16T06:56:40.000Z",
  });
});

test("Binance USER_DATA 查询使用官方 HMAC-SHA256 签名", () => {
  const query = "symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943";
  const secret = "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9";

  assert.equal(
    signBinanceQuery(query, secret),
    "3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9",
  );
});

test("凭证验证会读取 Binance U 本位唯一账户别名作为稳定身份", async () => {
  const requests = [];
  const client = createBinanceUsdmClient({
    now: () => 1784189000000,
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url.pathname);
      if (url.pathname === "/fapi/v1/time") {
        return Response.json({ serverTime: 1784189000000 });
      }
      if (url.pathname === "/fapi/v3/balance") {
        return Response.json([
          { accountAlias: "SgsR", asset: "USDT", balance: "100" },
          { accountAlias: "SgsR", asset: "USDC", balance: "0" },
        ]);
      }
      return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
    },
  });

  const identity = await client.validateCredentials({
    apiKey: "api-key",
    apiSecret: "api-secret",
  });

  assert.deepEqual(identity, { accountAlias: "SgsR" });
  assert.deepEqual(requests, ["/fapi/v1/time", "/fapi/v3/balance"]);
});

test("基础委托映射为现有 Binance U 本位订单结构", () => {
  const order = normalizeNormalOrder({
    avgPrice: "66.431",
    cumQuote: "1519.94",
    executedQty: "22.88",
    orderId: 10905798348,
    origQty: "22.88",
    origType: "LIMIT",
    price: "66.431",
    reduceOnly: false,
    side: "BUY",
    positionSide: "BOTH",
    status: "FILLED",
    stopPrice: "0",
    symbol: "HYPEUSDT",
    time: 1784182961000,
    updateTime: 1784187197000,
    type: "LIMIT",
  }, "local-account");

  assert.deepEqual(order, {
    userId: "local-account",
    orderId: "10905798348",
    symbol: "HYPEUSDT",
    orderType: "LIMIT",
    side: "BUY",
    limitPrice: 66.431,
    averagePrice: 66.431,
    originalQuantity: 22.88,
    executedQuantity: 22.88,
    executedQuoteQuantity: 1519.94,
    stopPrice: null,
    status: "FILLED",
    createdAt: "2026-07-16T06:22:41.000Z",
    updatedAt: "2026-07-16T07:33:17.000Z",
    positionSide: "BOTH",
    reduceOnly: false,
    closePosition: false,
    workingType: null,
    sourceKind: "api-normal",
  });
});

test("逐笔成交保留 Binance 返回的真实 commission 与成交属性", () => {
  const fill = normalizeUserTrade({
    buyer: true,
    commission: "0.02657240",
    commissionAsset: "USDT",
    id: 991,
    maker: false,
    orderId: 10905798348,
    positionSide: "LONG",
    price: "66.431",
    qty: "1",
    quoteQty: "66.431",
    realizedPnl: "0",
    side: "BUY",
    symbol: "HYPEUSDT",
    time: 1784187197000,
  }, "local-account");

  assert.deepEqual(fill, {
    userId: "local-account",
    tradeId: "991",
    orderId: "10905798348",
    symbol: "HYPEUSDT",
    side: "BUY",
    positionSide: "LONG",
    price: 66.431,
    quantity: 1,
    quoteQuantity: 66.431,
    commission: 0.0265724,
    commissionAsset: "USDT",
    realizedPnl: 0,
    time: "2026-07-16T07:33:17.000Z",
    maker: false,
  });
});

test("当前持仓快照只保留非零仓位，且不会把更新时间伪造成开仓时间", () => {
  const position = normalizeOpenPosition({
    symbol: "BTCUSDT",
    positionSide: "BOTH",
    positionAmt: "-0.071",
    entryPrice: "61986.40",
    breakEvenPrice: "62011.19456",
    markPrice: "61000.10",
    unRealizedProfit: "70.0313",
    marginAsset: "USDT",
    updateTime: 1784187197000,
  }, "local-account");

  assert.deepEqual(position, {
    userId: "local-account",
    symbol: "BTCUSDT",
    positionSide: "BOTH",
    side: "short",
    quantity: 0.071,
    entryPrice: 61986.4,
    breakEvenPrice: 62011.19456,
    markPrice: 61000.1,
    unRealizedProfit: 70.0313,
    marginAsset: "USDT",
    updateTime: "2026-07-16T07:33:17.000Z",
  });
  assert.equal(Object.hasOwn(position, "entryTime"), false);
  assert.equal(normalizeOpenPosition({
    symbol: "BTCUSDT",
    positionSide: "BOTH",
    positionAmt: "0",
  }, "local-account"), null);
});

test("Algo 条件单映射为 TP/SL 生命周期且不重复充当成交单", () => {
  const order = normalizeAlgoOrder({
    algoId: 2148627,
    algoType: "CONDITIONAL",
    orderType: "TAKE_PROFIT_MARKET",
    symbol: "HYPEUSDT",
    side: "SELL",
    positionSide: "BOTH",
    quantity: "22.88",
    algoStatus: "CANCELED",
    actualOrderId: "",
    actualPrice: "0",
    triggerPrice: "67.179",
    price: "0",
    workingType: "CONTRACT_PRICE",
    closePosition: true,
    reduceOnly: true,
    createTime: 1784187325000,
    updateTime: 1784189057000,
    triggerTime: 0,
  }, "local-account");

  assert.equal(order.orderId, "algo:2148627");
  assert.equal(order.orderType, "TAKE_PROFIT_MARKET");
  assert.equal(order.limitPrice, null);
  assert.equal(order.stopPrice, 67.179);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.executedQuantity, 0);
  assert.equal(order.sourceKind, "api-algo");
  assert.equal(order.closePosition, true);
});

test("Algo 新响应使用独立 TP/SL 字段时仍保留触发价和限价", () => {
  const stop = normalizeAlgoOrder({
    algoId: 30,
    orderType: "STOP_MARKET",
    symbol: "PUMPUSDT",
    side: "SELL",
    positionSide: "LONG",
    quantity: "921365",
    algoStatus: "NEW",
    triggerPrice: "0",
    slTriggerPrice: "0.001614",
    slPrice: "0",
    price: "0",
    createTime: 1784292510000,
    updateTime: 1784292510000,
  }, "local-account");
  const takeProfit = normalizeAlgoOrder({
    algoId: 31,
    orderType: "TAKE_PROFIT",
    symbol: "PUMPUSDT",
    side: "SELL",
    positionSide: "LONG",
    quantity: "921365",
    algoStatus: "NEW",
    triggerPrice: "0",
    tpTriggerPrice: "0.0017",
    tpPrice: "0.00169",
    price: "0",
    createTime: 1784292510000,
    updateTime: 1784292510000,
  }, "local-account");

  assert.equal(stop.stopPrice, 0.001614);
  assert.equal(stop.limitPrice, null);
  assert.equal(takeProfit.stopPrice, 0.0017);
  assert.equal(takeProfit.limitPrice, 0.00169);
});

test("同步会自动从收益流水和全账户挂单发现交易对，再读取基础单与 Algo 条件单", async () => {
  const requests = [];
  const normal = {
    avgPrice: "100", cumQuote: "100", executedQty: "1", orderId: 10,
    origQty: "1", origType: "MARKET", price: "0", side: "BUY",
    status: "FILLED", stopPrice: "0", symbol: "BTCUSDT",
    time: 1784182961000, updateTime: 1784182961000,
  };
  const algo = {
    algoId: 20, orderType: "STOP_MARKET", symbol: "BTCUSDT", side: "SELL",
    positionSide: "BOTH", quantity: "1", algoStatus: "NEW",
    triggerPrice: "95", price: "0", createTime: 1784182961000,
    updateTime: 1784182961000, triggerTime: 0,
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname === "/fapi/v1/time") {
      return Response.json({ serverTime: 1784189000000 });
    }
    if (url.pathname === "/fapi/v1/income") {
      return Response.json([{
        symbol: "BTCUSDT",
        incomeType: "COMMISSION",
        income: "-0.04",
        time: 1784182961000,
        tranId: 1,
      }]);
    }
    if (url.pathname === "/fapi/v3/positionRisk" || url.pathname === "/fapi/v1/userTrades") {
      return Response.json([]);
    }
    if (url.pathname === "/fapi/v1/openOrders" || url.pathname === "/fapi/v1/allOrders") {
      return Response.json([normal]);
    }
    if (url.pathname === "/fapi/v1/openAlgoOrders" || url.pathname === "/fapi/v1/allAlgoOrders") {
      return Response.json([algo]);
    }
    return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
  };
  const client = createBinanceUsdmClient({
    fetchImpl,
    now: () => 1784189000000,
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.equal(result.orders.length, 2);
  assert.deepEqual(result.symbols, ["BTCUSDT"]);
  assert.equal(result.normalOrderCount, 1);
  assert.equal(result.algoOrderCount, 1);
  assert.deepEqual(
    requests.slice(1).map(({ url }) => url.pathname),
    [
      "/fapi/v1/income",
      "/fapi/v3/positionRisk",
      "/fapi/v1/openOrders",
      "/fapi/v1/openAlgoOrders",
      "/fapi/v1/allOrders",
      "/fapi/v1/allAlgoOrders",
      "/fapi/v1/userTrades",
    ],
  );
  const incomeRequest = requests.find(({ url }) => url.pathname === "/fapi/v1/income");
  assert.equal(incomeRequest.url.searchParams.get("page"), "1");
  assert.equal(incomeRequest.url.searchParams.get("limit"), "1000");
  const allOpenRequests = requests.filter(({ url }) =>
    url.pathname === "/fapi/v1/openOrders" || url.pathname === "/fapi/v1/openAlgoOrders"
  );
  assert.equal(allOpenRequests.length, 2);
  for (const { url } of allOpenRequests) assert.equal(url.searchParams.has("symbol"), false);
  for (const { url, init } of requests.slice(1)) {
    assert.equal(init.method, "GET");
    assert.equal(init.headers["X-MBX-APIKEY"], "api-key");
    assert.match(url.searchParams.get("signature") ?? "", /^[a-f0-9]{64}$/);
  }
});

test("收益流水达到 1000 条时按 page 继续发现后续交易对", async () => {
  const incomeRequests = [];
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    symbol: index % 2 === 0 ? "BTCUSDT" : "SOLUSDT",
    incomeType: "COMMISSION",
    income: "-0.01",
    time: 1784180000000 + index,
    tranId: index + 1,
  }));
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/fapi/v1/time") {
      return Response.json({ serverTime: 1784189000000 });
    }
    if (url.pathname === "/fapi/v1/income") {
      incomeRequests.push({
        page: url.searchParams.get("page"),
        limit: url.searchParams.get("limit"),
      });
      return Response.json(url.searchParams.get("page") === "1"
        ? firstPage
        : [{
            symbol: "PUMPUSDT",
            incomeType: "REALIZED_PNL",
            income: "12",
            time: 1784188000000,
            tranId: 1001,
          }]);
    }
    if (url.pathname === "/fapi/v3/positionRisk" ||
        url.pathname === "/fapi/v1/openOrders" ||
        url.pathname === "/fapi/v1/openAlgoOrders") {
      return Response.json([]);
    }
    if (url.pathname === "/fapi/v1/allOrders" ||
        url.pathname === "/fapi/v1/allAlgoOrders" ||
        url.pathname === "/fapi/v1/userTrades") {
      return Response.json([]);
    }
    return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
  };
  const client = createBinanceUsdmClient({
    fetchImpl,
    now: () => 1784189000000,
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(result.symbols, ["BTCUSDT", "PUMPUSDT", "SOLUSDT"]);
  assert.deepEqual(incomeRequests, [
    { page: "1", limit: "1000" },
    { page: "2", limit: "1000" },
  ]);
});

test("全账户基础挂单与 Algo 挂单会补充收益流水中没有的交易对", async () => {
  const openNormal = {
    avgPrice: "0", cumQuote: "0", executedQty: "0", orderId: 31,
    origQty: "2.717", origType: "LIMIT", price: "577.17", side: "SELL",
    status: "NEW", stopPrice: "0", symbol: "ZECUSDT",
    time: 1784182961000, updateTime: 1784182961000,
  };
  const openAlgo = {
    algoId: 32, orderType: "STOP_MARKET", symbol: "PUMPUSDT", side: "SELL",
    positionSide: "BOTH", quantity: "1007485", algoStatus: "NEW",
    triggerPrice: "0.00159", price: "0", createTime: 1784182961000,
    updateTime: 1784182961000, triggerTime: 0,
  };
  const client = createBinanceUsdmClient({
    now: () => 1784189000000,
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/fapi/v1/time") {
        return Response.json({ serverTime: 1784189000000 });
      }
      if (url.pathname === "/fapi/v1/income") return Response.json([]);
      if (url.pathname === "/fapi/v3/positionRisk") return Response.json([]);
      if (url.pathname === "/fapi/v1/openOrders") return Response.json([openNormal]);
      if (url.pathname === "/fapi/v1/openAlgoOrders") return Response.json([openAlgo]);
      if (url.pathname === "/fapi/v1/allOrders" ||
          url.pathname === "/fapi/v1/allAlgoOrders" ||
          url.pathname === "/fapi/v1/userTrades") {
        return Response.json([]);
      }
      return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
    },
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(result.symbols, ["PUMPUSDT", "ZECUSDT"]);
  assert.equal(result.normalOrderCount, 1);
  assert.equal(result.algoOrderCount, 1);
});

test("没有收益流水或当前挂单时返回空同步结果而不是要求填写交易对", async () => {
  const historyRequests = [];
  const client = createBinanceUsdmClient({
    now: () => 1784189000000,
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/fapi/v1/time") {
        return Response.json({ serverTime: 1784189000000 });
      }
      if (url.pathname === "/fapi/v1/income" ||
          url.pathname === "/fapi/v3/positionRisk" ||
          url.pathname === "/fapi/v1/openOrders" ||
          url.pathname === "/fapi/v1/openAlgoOrders") {
        return Response.json([]);
      }
      historyRequests.push(url.pathname);
      return Response.json([]);
    },
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.orders, []);
  assert.deepEqual(historyRequests, []);
});

test("同步未平仓仓位时同时保留 userTrades 手续费与真实资金费流水", async () => {
  const requests = [];
  const entryOrder = {
    avgPrice: "100", cumQuote: "200", executedQty: "2", orderId: 88,
    origQty: "2", origType: "MARKET", price: "0", side: "BUY",
    positionSide: "LONG", status: "FILLED", stopPrice: "0", symbol: "BTCUSDT",
    time: 1784182961000, updateTime: 1784182961000,
  };
  const client = createBinanceUsdmClient({
    now: () => 1784189000000,
    fetchImpl: async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname === "/fapi/v1/time") {
        return Response.json({ serverTime: 1784189000000 });
      }
      if (url.pathname === "/fapi/v1/income") {
        return Response.json([{
          symbol: "BTCUSDT",
          incomeType: "FUNDING_FEE",
          income: "-0.75",
          asset: "USDT",
          time: 1784185000000,
          tranId: 9001,
        }]);
      }
      if (url.pathname === "/fapi/v1/openOrders" ||
          url.pathname === "/fapi/v1/openAlgoOrders" ||
          url.pathname === "/fapi/v1/allAlgoOrders") {
        return Response.json([]);
      }
      if (url.pathname === "/fapi/v3/positionRisk") {
        return Response.json([{
          symbol: "BTCUSDT",
          positionSide: "LONG",
          positionAmt: "2",
          entryPrice: "100",
          breakEvenPrice: "100.04",
          markPrice: "110",
          unRealizedProfit: "20",
          marginAsset: "USDT",
          updateTime: 1784187197000,
        }]);
      }
      if (url.pathname === "/fapi/v1/allOrders") return Response.json([entryOrder]);
      if (url.pathname === "/fapi/v1/userTrades") {
        return Response.json([{
          commission: "0.08",
          commissionAsset: "USDT",
          id: 501,
          maker: false,
          orderId: 88,
          positionSide: "LONG",
          price: "100",
          qty: "2",
          quoteQty: "200",
          realizedPnl: "0",
          side: "BUY",
          symbol: "BTCUSDT",
          time: 1784182961000,
        }]);
      }
      return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
    },
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.deepEqual(result.symbols, ["BTCUSDT"]);
  assert.equal(result.openPositionCount, 1);
  assert.equal(result.fillCount, 1);
  assert.equal(result.fundingFeeCount, 1);
  assert.equal(result.orders.length, 1);
  assert.deepEqual(result.orders[0].fills, [{
    userId: "local-account",
    tradeId: "501",
    orderId: "88",
    symbol: "BTCUSDT",
    side: "BUY",
    positionSide: "LONG",
    price: 100,
    quantity: 2,
    quoteQuantity: 200,
    commission: 0.08,
    commissionAsset: "USDT",
    realizedPnl: 0,
    time: "2026-07-16T06:22:41.000Z",
    maker: false,
  }]);
  assert.equal(result.openPositions[0].entryPrice, 100);
  assert.equal(result.openPositions[0].fundingFeesKnown, true);
  assert.deepEqual(result.openPositions[0].fundingFees, [{
    userId: "local-account",
    transactionId: "9001",
    symbol: "BTCUSDT",
    incomeType: "FUNDING_FEE",
    amount: -0.75,
    asset: "USDT",
    time: "2026-07-16T06:56:40.000Z",
  }]);
  assert.equal(Object.hasOwn(result.openPositions[0], "entryTime"), false);
  assert.equal(requests.filter((url) => url.pathname === "/fapi/v3/positionRisk").length, 1);
  assert.equal(requests.filter((url) => url.pathname === "/fapi/v1/userTrades").length, 1);
});

test("同一交易对双向持仓不会把一笔资金费重复计入多空两边", async () => {
  const client = createBinanceUsdmClient({
    now: () => 1784189000000,
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/fapi/v1/time") {
        return Response.json({ serverTime: 1784189000000 });
      }
      if (url.pathname === "/fapi/v1/income") {
        return Response.json([{
          symbol: "BTCUSDT",
          incomeType: "FUNDING_FEE",
          income: "-0.75",
          asset: "USDT",
          time: 1784185000000,
          tranId: 9001,
        }]);
      }
      if (url.pathname === "/fapi/v3/positionRisk") {
        return Response.json(["LONG", "SHORT"].map((positionSide) => ({
          symbol: "BTCUSDT",
          positionSide,
          positionAmt: positionSide === "LONG" ? "2" : "-1",
          entryPrice: "100",
          breakEvenPrice: "100.04",
          markPrice: "110",
          unRealizedProfit: positionSide === "LONG" ? "20" : "-10",
          marginAsset: "USDT",
          updateTime: 1784187197000,
        })));
      }
      return Response.json([]);
    },
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.equal(result.fundingFeeCount, 1);
  assert.equal(result.openPositions.length, 2);
  assert.ok(result.openPositions.every((position) => position.fundingFeesKnown === false));
  assert.ok(result.openPositions.every((position) => position.fundingFees.length === 0));
  assert.ok(result.openPositions.every((position) => /无法精确归属/.test(position.fundingFeeNotice)));
});

test("Binance 返回 429 时遵守 Retry-After 后重试私有查询", async () => {
  let incomeAttempts = 0;
  const delays = [];
  const client = createBinanceUsdmClient({
    now: () => 1784189000000,
    sleep: async (delay) => delays.push(delay),
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/fapi/v1/time") {
        return Response.json({ serverTime: 1784189000000 });
      }
      if (url.pathname === "/fapi/v1/income") {
        incomeAttempts += 1;
        if (incomeAttempts === 1) {
          return Response.json(
            { code: -1003, msg: "Too many requests" },
            { status: 429, headers: { "Retry-After": "2" } },
          );
        }
        return Response.json([]);
      }
      if (url.pathname === "/fapi/v1/openOrders" || url.pathname === "/fapi/v1/openAlgoOrders") {
        return Response.json([]);
      }
      return Response.json([]);
    },
  });

  await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    startTime: 1784102400000,
    endTime: 1784188799000,
  });

  assert.equal(incomeAttempts, 2);
  assert.deepEqual(delays, [2000]);
});

test("单个时间窗口达到 1000 条时会继续细分，避免 Binance 历史结果被截断", async () => {
  const startTime = 1784102400000;
  const endTime = startTime + 1000;
  const midpoint = Math.floor((startTime + endTime) / 2);
  const allOrdersRequests = [];
  const makeOrder = (orderId, time) => ({
    avgPrice: "100",
    cumQuote: "100",
    executedQty: "1",
    orderId,
    origQty: "1",
    origType: "MARKET",
    price: "0",
    side: orderId % 2 === 0 ? "BUY" : "SELL",
    status: "FILLED",
    stopPrice: "0",
    symbol: "BTCUSDT",
    time,
    updateTime: time,
  });
  const earlier = Array.from(
    { length: 600 },
    (_, index) => makeOrder(index + 1, startTime + (index % (midpoint - startTime + 1))),
  );
  const later = Array.from(
    { length: 400 },
    (_, index) => makeOrder(index + 601, midpoint + 1 + (index % (endTime - midpoint))),
  );

  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/fapi/v1/time") {
      return Response.json({ serverTime: endTime + 60_000 });
    }
    if (url.pathname === "/fapi/v1/income") {
      return Response.json([]);
    }
    if (url.pathname === "/fapi/v3/positionRisk" ||
        url.pathname === "/fapi/v1/openOrders" ||
        url.pathname === "/fapi/v1/openAlgoOrders") {
      return Response.json([]);
    }
    if (url.pathname === "/fapi/v1/allAlgoOrders") {
      return Response.json([]);
    }
    if (url.pathname === "/fapi/v1/userTrades") {
      return Response.json([]);
    }
    if (url.pathname === "/fapi/v1/allOrders") {
      const requestStart = Number(url.searchParams.get("startTime"));
      const requestEnd = Number(url.searchParams.get("endTime"));
      allOrdersRequests.push({ startTime: requestStart, endTime: requestEnd });
      if (requestStart === startTime && requestEnd === endTime) {
        return Response.json([...earlier, ...later]);
      }
      if (requestEnd <= midpoint) return Response.json(earlier);
      return Response.json(later);
    }
    return Response.json({ code: -1, msg: "unexpected" }, { status: 404 });
  };
  const client = createBinanceUsdmClient({
    fetchImpl,
    now: () => endTime + 60_000,
  });

  const result = await client.syncOrders({
    apiKey: "api-key",
    apiSecret: "api-secret",
    accountId: "local-account",
    symbols: ["BTCUSDT"],
    startTime,
    endTime,
  });

  assert.equal(result.orders.length, 1000);
  assert.deepEqual(allOrdersRequests, [
    { startTime, endTime },
    { startTime, endTime: midpoint },
    { startTime: midpoint + 1, endTime },
  ]);
});
