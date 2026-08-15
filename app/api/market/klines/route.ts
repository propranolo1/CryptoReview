import { NextRequest, NextResponse } from "next/server";
import {
  createBinanceFuturesKlineUrl,
  parseBinanceKlines,
} from "@/lib/market.mjs";

const SUPPORTED_INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
]);

function parseOptionalTimestamp(value: string | null) {
  if (!value) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const symbol = (query.get("symbol") ?? "")
    .toUpperCase()
    .replace(/[\s/_-]/g, "");
  const interval = query.get("interval") ?? "1h";
  const market = query.get("market") ?? "binance";
  const startTime = parseOptionalTimestamp(query.get("startTime"));
  const endTime = parseOptionalTimestamp(query.get("endTime"));
  const limit = Number(query.get("limit") ?? 500);

  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    return NextResponse.json(
      { message: "交易对格式无效，请使用 BTCUSDT 这类 Binance 交易对。" },
      { status: 400 },
    );
  }

  if (!SUPPORTED_INTERVALS.has(interval)) {
    return NextResponse.json({ message: "不支持的 K 线时间框架。" }, { status: 400 });
  }

  if (market !== "binance" && market !== "binance-futures") {
    return NextResponse.json({ message: "不支持的行情数据源。" }, { status: 400 });
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return NextResponse.json({ message: "K 线数量必须是 1 到 1000 的整数。" }, { status: 400 });
  }

  if ((query.has("startTime") && !startTime) || (query.has("endTime") && !endTime)) {
    return NextResponse.json({ message: "开始或结束时间戳无效。" }, { status: 400 });
  }

  if (startTime && endTime && startTime > endTime) {
    return NextResponse.json({ message: "开始时间不能晚于结束时间。" }, { status: 400 });
  }

  const endpoint = market === "binance-futures"
    ? new URL(createBinanceFuturesKlineUrl({
        symbol,
        interval,
        startTime,
        endTime,
        limit,
      }))
    : new URL("https://data-api.binance.vision/api/v3/klines");

  if (market === "binance") {
    endpoint.searchParams.set("symbol", symbol);
    endpoint.searchParams.set("interval", interval);
    endpoint.searchParams.set("limit", String(limit));
    if (startTime) endpoint.searchParams.set("startTime", String(startTime));
    if (endTime) endpoint.searchParams.set("endTime", String(endTime));
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload)) {
      const upstreamMessage =
        response.status === 451
          ? `Binance ${market === "binance-futures" ? "Futures" : "Spot"} 官方接口因当前网络位置受限，无法读取历史 K 线`
          : payload && typeof payload === "object" && "msg" in payload
          ? String(payload.msg)
          : "行情服务暂时不可用";
      return NextResponse.json(
        { message: upstreamMessage },
        { status: response.status >= 400 ? response.status : 502 },
      );
    }

    const candles = parseBinanceKlines(payload);
    return NextResponse.json(
      {
        source: market === "binance-futures" ? "Binance Futures · USDⓈ-M 永续" : "Binance Spot",
        symbol,
        interval,
        candles,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        message: `无法连接 Binance ${market === "binance-futures" ? "Futures" : "Spot"} 历史行情，稍后可重试。`,
      },
      { status: 502 },
    );
  }
}
