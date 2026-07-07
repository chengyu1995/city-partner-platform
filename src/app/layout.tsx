import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "同城搭子 - 找兴趣相投的同城朋友 | 20-35 岁兴趣社交",
  description: "20-35 岁同城兴趣社交平台。首批支持惠州、广州、深圳、上海，覆盖饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子。",
  keywords: ["同城搭子", "兴趣社交", "饭搭子", "运动搭子", "学习搭子", "出游搭子", "K歌搭子", "摩友搭子", "钓友搭子", "20-35岁", "同城交友"],
  authors: [{ name: "同城搭子" }],
  openGraph: {
    title: "同城搭子 - 找兴趣相投的同城朋友",
    description: "首批开放惠州、广州、深圳、上海，支持饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子。",
    type: "website",
    locale: "zh_CN",
    siteName: "同城搭子",
  },
  twitter: {
    card: "summary_large_image",
    title: "同城搭子",
    description: "20-35 岁同城兴趣社交平台",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1b4b" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-screen bg-white text-slate-900">{children}</body>
    </html>
  );
}
