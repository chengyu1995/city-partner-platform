import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "同城搭子",
  description: "MVP 脚手架：Next.js + Tailwind + shadcn/ui + Supabase",
};

/**
 * 防 dark mode 闪白的 inline script.
 * - 在 hydration 前同步执行 (浏览器解析到 <script> 就跑, 不等 React)
 * - 读 localStorage.theme, 给 <html> 加/去 "dark" class
 * - 必须用 dangerouslySetInnerHTML, 否则 Next.js 会包一层
 */
const themeScript = `
(function(){
  try {
    var t = localStorage.getItem("theme");
    if (t === "dark" || (!t && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
