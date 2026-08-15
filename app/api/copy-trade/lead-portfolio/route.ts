import { NextRequest, NextResponse } from "next/server";

const BINANCE_PUBLIC_API =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade";
const PORTFOLIO_ID_PATTERN = /^\d{12,24}$/;
const PAGE_SIZE = 200;
const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_DELAY_MS = 900;

type BinanceEnvelope<T> = {
  code?: string | number;
  message?: unknown;
  messageDetail?: unknown;
  data?: T;
  success?: boolean;
};

type OrderHistoryPage = {
  indexValue?: string;
  total?: number;
  list?: unknown[];
};

export async function POST(request: NextRequest) {
  let body: { portfolioId?: unknown; fullHistory?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "请求内容不是有效 JSON。" }, { status: 400 });
  }

  const portfolioId = String(body.portfolioId ?? "").trim();
  if (!PORTFOLIO_ID_PATTERN.test(portfolioId)) {
    return NextResponse.json({ message: "Binance portfolioId 无效。" }, { status: 400 });
  }
  const fullHistory = body.fullHistory === true;
  const referer =
    `https://www.binance.com/zh-CN/copy-trading/lead-details/${portfolioId}`;

  try {
    const [detail, positionsResult, orderHistoryResult] = await Promise.all([
      requestBinancePublic<Record<string, unknown>>(
        `${BINANCE_PUBLIC_API}/lead-portfolio/detail?portfolioId=${portfolioId}`,
        { method: "GET", referer },
      ),
      requestBinancePublic<unknown[]>(
        `${BINANCE_PUBLIC_API}/lead-data/positions?portfolioId=${portfolioId}`,
        { method: "GET", referer },
      ).then(
        (positions) => ({ positions, warning: null }),
        () => ({
          positions: [] as unknown[],
          warning: "本次未能读取当前仓位，成交历史仍已同步。",
        }),
      ),
      fetchOrderHistory(portfolioId, fullHistory, referer),
    ]);

    const { historyWarnings, ...orderHistory } = orderHistoryResult;
    const warnings = [
      ...(positionsResult.warning ? [positionsResult.warning] : []),
      ...historyWarnings,
    ];
    return NextResponse.json(
      {
        portfolioId,
        fetchedAt: new Date().toISOString(),
        detail,
        positions: positionsResult.positions,
        orderHistory,
        warnings,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        message: error instanceof Error
          ? error.message
          : "Binance 公开带单数据暂时不可用。",
      },
      { status: 502 },
    );
  }
}

async function fetchOrderHistory(
  portfolioId: string,
  fullHistory: boolean,
  referer: string,
) {
  const list: unknown[] = [];
  const historyWarnings: string[] = [];
  let total = 0;
  const pageLimit = fullHistory ? MAX_HISTORY_PAGES : 1;

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    if (pageNumber > 1) {
      await new Promise((resolve) => setTimeout(resolve, HISTORY_PAGE_DELAY_MS));
    }
    let page: OrderHistoryPage;
    try {
      page = await requestBinancePublicWithRetry<OrderHistoryPage>(
        `${BINANCE_PUBLIC_API}/lead-portfolio/order-history`,
        {
          method: "POST",
          referer,
          body: JSON.stringify({
            portfolioId,
            pageNumber,
            pageSize: PAGE_SIZE,
          }),
        },
      );
    } catch (error) {
      if (pageNumber === 1) throw error;
      const reason = error instanceof Error ? `（${error.message}）` : "";
      historyWarnings.push(
        `订单历史第 ${pageNumber} 页暂时不可用${reason}，本次已保留前 ${list.length} 条，稍后可再次完整同步。`,
      );
      break;
    }
    const pageItems = Array.isArray(page?.list) ? page.list : [];
    total = Number.isInteger(Number(page?.total))
      ? Math.max(total, Number(page.total))
      : Math.max(total, list.length + pageItems.length);
    list.push(...pageItems);

    if (
      pageItems.length < PAGE_SIZE ||
      list.length >= total ||
      !fullHistory
    ) {
      break;
    }
  }

  return {
    total: Math.max(total, list.length),
    list,
    truncated: fullHistory && list.length < total,
    historyWarnings,
  };
}

async function requestBinancePublicWithRetry<T>(
  url: string,
  options: {
    method: "GET" | "POST";
    referer: string;
    body?: string;
  },
) {
  try {
    return await requestBinancePublic<T>(url, options);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, HISTORY_PAGE_DELAY_MS));
    return requestBinancePublic<T>(url, options);
  }
}

async function requestBinancePublic<T>(
  url: string,
  options: {
    method: "GET" | "POST";
    referer: string;
    body?: string;
  },
) {
  const response = await fetch(url, {
    method: options.method,
    body: options.body,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36",
      Referer: options.referer,
    },
  });
  if (!response.ok) {
    throw new Error(`Binance 公开接口返回 ${response.status}，请稍后重试。`);
  }
  const payload = await response.json() as BinanceEnvelope<T>;
  if (payload.success === false || payload.data === undefined) {
    const code = payload.code === undefined ? "" : `[${String(payload.code)}] `;
    const message = `${code}${formatBinanceMessage(
      payload.message ?? payload.messageDetail,
    )}`;
    throw new Error(message);
  }
  return payload.data;
}

function formatBinanceMessage(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
  if (value && typeof value === "object") {
    const text = Object.values(value)
      .find((item) => typeof item === "string" && item.trim());
    if (typeof text === "string") return text.trim().slice(0, 240);
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}") return serialized.slice(0, 240);
    } catch {
      // 继续使用通用提示。
    }
  }
  return "Binance 公开接口返回无效数据，请稍后重试。";
}
