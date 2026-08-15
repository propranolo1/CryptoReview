import { NextRequest, NextResponse } from "next/server";

const BINANCE_SMART_MONEY_PROFILE_API =
  "https://www.binance.com/bapi/asset/v1/friendly/future/smart-money/profile";
const TOP_TRADER_ID_PATTERN = /^\d{12,24}$/;
const PORTFOLIO_ID_PATTERN = /^\d{12,24}$/;

type BinanceEnvelope<T> = {
  code?: string | number;
  message?: unknown;
  messageDetail?: unknown;
  data?: T;
  success?: boolean;
};

type SmartMoneyProfile = Record<string, unknown> & {
  topTraderId?: unknown;
  futuresCopyTradePortfolioId?: unknown;
};

export async function POST(request: NextRequest) {
  let body: { topTraderId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "请求内容不是有效 JSON。" }, { status: 400 });
  }

  const topTraderId = String(body.topTraderId ?? "").trim();
  if (!TOP_TRADER_ID_PATTERN.test(topTraderId)) {
    return NextResponse.json({ message: "Binance topTraderId 无效。" }, { status: 400 });
  }
  const referer =
    `https://www.binance.com/zh-CN/smart-money/profile/${topTraderId}`;

  try {
    const response = await fetch(
      `${BINANCE_SMART_MONEY_PROFILE_API}?topTraderId=${topTraderId}`,
      {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: "application/json",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36",
          Referer: referer,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Binance 聪明钱公开接口返回 ${response.status}，请稍后重试。`);
    }
    const payload = await response.json() as BinanceEnvelope<SmartMoneyProfile>;
    if (payload.success === false || !payload.data) {
      throw new Error(formatBinanceMessage(payload.message ?? payload.messageDetail));
    }
    const responseTopTraderId = String(payload.data.topTraderId ?? "").trim();
    if (responseTopTraderId !== topTraderId) {
      throw new Error("Binance 聪明钱主页身份不一致，请重新复制主页链接。");
    }
    const futuresCopyTradePortfolioId = String(
      payload.data.futuresCopyTradePortfolioId ?? "",
    ).trim();
    if (!PORTFOLIO_ID_PATTERN.test(futuresCopyTradePortfolioId)) {
      return NextResponse.json(
        {
          message:
            "该聪明钱主页没有关联可公开读取的合约带单档案，无法生成真实买卖回放。",
        },
        { status: 422 },
      );
    }

    return NextResponse.json(
      {
        topTraderId,
        fetchedAt: new Date().toISOString(),
        profile: payload.data,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        message: error instanceof Error
          ? error.message
          : "Binance 聪明钱主页暂时不可用。",
      },
      { status: 502 },
    );
  }
}

function formatBinanceMessage(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
  if (value && typeof value === "object") {
    const text = Object.values(value)
      .find((item) => typeof item === "string" && item.trim());
    if (typeof text === "string") return text.trim().slice(0, 240);
  }
  return "Binance 聪明钱公开接口返回无效数据，请稍后重试。";
}
