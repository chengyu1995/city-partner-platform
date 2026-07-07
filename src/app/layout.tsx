import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "同城搭子 - 找兴趣相投的同城朋友 | 20-35 岁兴趣社交",
  description: "20-35 岁同城兴趣社交平台。找旅游搭子、K 歌搭子、学习搭子、摩友、钓友。几秒钟发个搭子帖, 遇见有趣的人。",
  keywords: ["同城搭子", "兴趣社交", "旅游搭子", "K歌搭子", "学习搭子", "摩友", "钓友", "20-35岁", "同城交友"],
  authors: [{ name: "同城搭子" }],
  openGraph: {
    title: "同城搭子 - 找兴趣相投的同城朋友",
    description: "20-35 岁同城兴趣社交平台。旅游/K歌/学习/摩友/钓友, 几秒钟发搭子帖。",
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
