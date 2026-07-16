import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const metadataBase = new URL(host ? `${protocol}://${host}` : "http://localhost:3000");
  const description = "导入历史仓位，逐根回放行情，并复盘每一笔交易的执行与盈亏。";
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: "复盘舱 · CryptoReview",
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title: "复盘舱 · 从入场开始，重看每一根 K 线",
      description,
      images: [{ url: socialImage, width: 1792, height: 1024, alt: "复盘舱交易复盘工作台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "复盘舱 · CryptoReview",
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
