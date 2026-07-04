import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "同城搭子",
  description: "找到今天就能见面的同城搭子",
};

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
