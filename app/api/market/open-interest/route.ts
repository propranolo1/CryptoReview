import { NextRequest, NextResponse } from "next/server";
import {
  createBinanceFuturesOpenInterestUrl,
  parseBinanceOpenInterestHistory,
} from "@/lib/market.mjs";

const SUPPORTED_PERIODS = new Set(["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"]);

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
  const period = query.get("period") ?? "5m";
  const startTime = parseOptionalTimestamp(query.get("startTime"));
  const endTime = parseOptionalTimestamp(query.get("endTime"));
  const limit = Number(query.get("limit") ?? 500);

  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    return NextResponse.json({ message: "交易对格式无效，请使用 BTCUSDT 这类 Binance 交易对。" }, { status: 400 });
  }
  if (!SUPPORTED_PERIODS.has(period)) {
    return NextResponse.json({ message: "该时间框架不支持历史 OI。" }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return NextResponse.json({ message: "OI 数量必须是 1 到 500 的整数。" }, { status: 400 });
  }
  if ((query.has("startTime") && !startTime) || (query.has("endTime") && !endTime)) {
    return NextResponse.json({ message: "开始或结束时间戳无效。" }, { status: 400 });
  }
  if (startTime && endTime && startTime > endTime) {
    return NextResponse.json({ message: "开始时间不能晚于结束时间。" }, { status: 400 });
  }

  const endpoint = createBinanceFuturesOpenInterestUrl({
    symbol,
    period,
    startTime,
    endTime,
    limit,
  });

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload)) {
      const upstreamMessage = response.status === 451
        ? "Binance Futures OI 接口因当前网络位置受限。"
        : payload && typeof payload === "object" && "msg" in payload
          ? String(payload.msg)
          : "Binance Futures OI 暂时不可用。";
      return NextResponse.json(
        { message: upstreamMessage },
        { status: response.status >= 400 ? response.status : 502 },
      );
    }

    return NextResponse.json(
      {
        source: "Binance Futures · 历史 OI",
        symbol,
        period,
        points: parseBinanceOpenInterestHistory(payload),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch {
    return NextResponse.json(
      { message: "无法连接 Binance Futures 历史 OI，价格与成交量仍可正常回放。" },
      { status: 502 },
    );
  }
}
