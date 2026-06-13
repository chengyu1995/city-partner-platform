import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      {/* 右上角主题切换按钮 */}
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">同城搭子</h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        MVP 脚手架已就位：Next.js + TypeScript + Tailwind + shadcn/ui（经典 Radix 风格）。
        下一步：登录、活动列表、组局详情。
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/activities">浏览活动</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="https://github.com" target="_blank" rel="noreferrer">
            查看仓库
          </Link>
        </Button>
      </div>
    </main>
  )
}
