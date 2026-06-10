import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "同城搭子",
  description: "MVP 脚手架：Next.js + Tailwind + shadcn/ui + Supabase",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
