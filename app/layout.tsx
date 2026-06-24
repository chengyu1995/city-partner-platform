import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "同城搭子",
  description: "寻找同城饭搭子、运动搭子、学习搭子和周末出游伙伴。"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
