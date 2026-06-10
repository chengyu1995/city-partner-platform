import Link from "next/link"
import { listActivities } from "@/lib/db"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { format } from "date-fns"
import { zhCN } from "date-fns/locale"

export const dynamic = "force-dynamic" // 总是从 server 拉最新数据

export default async function ActivitiesPage() {
  const activities = await listActivities()
  return (
    <main className="container py-10">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-3xl font-bold">活动列表</h1>
        <Button asChild>
          <Link href="/activities/new">+ 发起活动</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Next.js + shadcn/ui + Supabase，{activities.length} 个活动
      </p>
      <Separator className="my-4" />
      {activities.length === 0 ? (
        <p className="text-muted-foreground text-center py-20">还没有活动。点上方按钮发起一个吧！</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {activities.map((a) => (
            <Card key={a.id}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback>{a.host_name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <div>
                    <CardTitle>{a.title}</CardTitle>
                    <CardDescription>由 {a.host_name} 发起</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm">
                  {format(new Date(a.starts_at), "PPP p", { locale: zhCN })}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">📍 {a.location}</p>
                <p className="mt-2 text-sm text-muted-foreground">容量 {a.capacity} 人</p>
              </CardContent>
              <CardFooter>
                <Button asChild className="w-full">
                  <Link href={`/activities/${a.id}`}>查看 / 报名</Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </main>
  )
}
