import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_OPEN_INTEREST_MAX_PAGES,
  VIDEO_OPEN_INTEREST_PAGE_LIMIT,
  createVideoOpenInterestRequestUrl,
  fetchVideoOpenInterest,
} from "../lib/video-open-interest.mjs";

const PERIOD_MS = 5 * 60 * 1000;
const START_TIME = Date.parse("2026-07-01T00:00:00.000Z");

function point(index, overrides = {}) {
  return {
    time: (START_TIME + index * PERIOD_MS) / 1000,
    openInterest: 10_000 + index,
    openInterestValue: 20_000 + index,
    ...overrides,
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("视频 OI 请求固定使用现有接口和 limit=500，并规范化交易对", () => {
  assert.equal(VIDEO_OPEN_INTEREST_PAGE_LIMIT, 500);
  assert.equal(VIDEO_OPEN_INTEREST_MAX_PAGES, 64);

  const url = new URL(
    createVideoOpenInterestRequestUrl({
      symbol: "btc/usdt",
      period: "5m",
      startTime: START_TIME,
      endTime: START_TIME + PERIOD_MS,
    }),
    "http://localhost",
  );

  assert.equal(url.pathname, "/api/market/open-interest");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    symbol: "BTCUSDT",
    period: "5m",
    startTime: String(START_TIME),
    endTime: String(START_TIME + PERIOD_MS),
    limit: "500",
  });
});

test("按最后一个 OI 时间戳加 1ms 向后分页，并去除跨页重复点", async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) => point(index));
  const secondPage = [
    point(499),
    {
      timestamp: START_TIME + 500 * PERIOD_MS,
      openInterest: 10_500,
      openInterestValue: 20_500,
    },
    point(501),
  ];
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1
      ? response({
          source: "Binance Futures · 历史 OI",
          symbol: "BTCUSDT",
          period: "5m",
          points: firstPage,
        })
      : response({
          source: "Binance Futures · 历史 OI",
          symbol: "BTCUSDT",
          period: "5m",
          points: secondPage,
        });
  };

  const signal = new AbortController().signal;
  const result = await fetchVideoOpenInterest({
    symbol: "BTCUSDT",
    period: "5m",
    startTime: START_TIME,
    endTime: START_TIME + 600 * PERIOD_MS,
    signal,
  }, fetcher);

  assert.equal(requests.length, 2);
  const secondUrl = new URL(requests[1].url, "http://localhost");
  assert.equal(
    secondUrl.searchParams.get("startTime"),
    String(START_TIME + 499 * PERIOD_MS + 1),
  );
  assert.equal(requests[0].init.signal, signal);
  assert.equal(requests[1].init.signal, signal);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.points.length, 502);
  assert.equal(result.points[0].time, START_TIME / 1000);
  assert.equal(result.points.at(-1).time, (START_TIME + 501 * PERIOD_MS) / 1000);
  assert.equal(
    result.points.filter((item) => item.time === point(499).time).length,
    1,
  );
  assert.equal(result.source, "Binance Futures · 历史 OI");
});

test("不足 500 条或空页立即结束，不补零也不伪造缺失时间点", async () => {
  let calls = 0;
  const result = await fetchVideoOpenInterest({
    symbol: "BTCUSDT",
    period: "15m",
    startTime: START_TIME,
    endTime: START_TIME + 20 * PERIOD_MS,
  }, async () => {
    calls += 1;
    return response({
      symbol: "BTCUSDT",
      period: "15m",
      points: [point(0), point(3), point(9)],
    });
  });

  assert.equal(calls, 1);
  assert.deepEqual(
    result.points.map((item) => item.time),
    [point(0).time, point(3).time, point(9).time],
  );

  const empty = await fetchVideoOpenInterest({
    symbol: "BTCUSDT",
    period: "15m",
    startTime: START_TIME,
    endTime: START_TIME + PERIOD_MS,
  }, async () => response({ symbol: "BTCUSDT", period: "15m", points: [] }));
  assert.deepEqual(empty.points, []);
  assert.equal(empty.pagesFetched, 1);
});

test("配置严格校验交易对、周期、时间范围和最大页数", async () => {
  const unusedFetcher = async () => {
    throw new Error("不应发起请求");
  };

  await assert.rejects(
    fetchVideoOpenInterest({
      symbol: "BTC",
      period: "5m",
      startTime: START_TIME,
      endTime: START_TIME + PERIOD_MS,
    }, unusedFetcher),
    /交易对格式/,
  );
  await assert.rejects(
    fetchVideoOpenInterest({
      symbol: "BTCUSDT",
      period: "1m",
      startTime: START_TIME,
      endTime: START_TIME + PERIOD_MS,
    }, unusedFetcher),
    /时间框架/,
  );
  await assert.rejects(
    fetchVideoOpenInterest({
      symbol: "BTCUSDT",
      period: "5m",
      startTime: START_TIME + PERIOD_MS,
      endTime: START_TIME,
    }, unusedFetcher),
    /开始时间不能晚于结束时间/,
  );
  await assert.rejects(
    fetchVideoOpenInterest({
      symbol: "BTCUSDT",
      period: "5m",
      startTime: START_TIME,
      endTime: START_TIME + PERIOD_MS,
      maxPages: VIDEO_OPEN_INTEREST_MAX_PAGES + 1,
    }, unusedFetcher),
    /最大分页数/,
  );
});

test("HTTP 错误、响应结构错误和交易对不一致均明确失败", async () => {
  const options = {
    symbol: "BTCUSDT",
    period: "5m",
    startTime: START_TIME,
    endTime: START_TIME + PERIOD_MS,
  };

  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({ message: "OI 上游不可用" }, 502)),
    /OI 上游不可用/,
  );
  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({ symbol: "BTCUSDT", period: "5m", points: null })),
    /points/,
  );
  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({ symbol: "ETHUSDT", period: "5m", points: [] })),
    /交易对不一致/,
  );
});

test("严格拒绝缺字段、负值、倒序和同一时间戳的冲突数据", async () => {
  const options = {
    symbol: "BTCUSDT",
    period: "5m",
    startTime: START_TIME,
    endTime: START_TIME + 10 * PERIOD_MS,
  };

  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({
        symbol: "BTCUSDT",
        period: "5m",
        points: [{
          time: START_TIME / 1000,
          openInterest: 1,
        }],
      })),
    /openInterestValue/,
  );
  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({
        symbol: "BTCUSDT",
        period: "5m",
        points: [point(0, { openInterest: -1 })],
      })),
    /openInterest/,
  );
  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({
        symbol: "BTCUSDT",
        period: "5m",
        points: [point(2), point(1)],
      })),
    /时间必须按升序/,
  );
  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({
        symbol: "BTCUSDT",
        period: "5m",
        points: [
          point(1),
          point(1, { openInterest: 999 }),
        ],
      })),
    /同一时间戳的数据不一致/,
  );
});

test("分页没有向后推进时失败，达到页数上限时不返回不完整数据", async () => {
  const fullPage = Array.from({ length: 500 }, (_, index) => point(index));
  const options = {
    symbol: "BTCUSDT",
    period: "5m",
    startTime: START_TIME,
    endTime: START_TIME + 2_000 * PERIOD_MS,
  };

  await assert.rejects(
    fetchVideoOpenInterest(options, async () =>
      response({
        symbol: "BTCUSDT",
        period: "5m",
        points: fullPage,
      })),
    /分页游标没有向后推进/,
  );

  let page = 0;
  await assert.rejects(
    fetchVideoOpenInterest({ ...options, maxPages: 2 }, async () => {
      const offset = page * 500;
      page += 1;
      return response({
        symbol: "BTCUSDT",
        period: "5m",
        points: Array.from({ length: 500 }, (_, index) => point(offset + index)),
      });
    }),
    /超过最大分页数 2/,
  );
});

test("AbortSignal 在请求前已取消时不发起请求，请求过程中也透传同一信号", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await assert.rejects(
    fetchVideoOpenInterest({
      symbol: "BTCUSDT",
      period: "5m",
      startTime: START_TIME,
      endTime: START_TIME + PERIOD_MS,
      signal: controller.signal,
    }, async () => {
      called = true;
      return response({ points: [] });
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(called, false);
});
