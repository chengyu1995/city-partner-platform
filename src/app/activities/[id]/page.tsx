import Link from "next/link"
import { notFound } from "next/navigation"
import { getActivity } from "@/lib/db"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { format } from "date-fns"
import { zhCN } from "date-fns/locale"

export const dynamic = "force-dynamic"
export const runtime = "nodejs";

export default async function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const activity = await getActivity(id)
  if (!activity) notFound()

  return (
    <main className="container max-w-2xl py-10">
      <Button asChild variant="ghost" className="mb-4">
        <Link href="/activities">← 返回列表</Link>
      </Button>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarFallback>{activity.host_name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div>
              <CardTitle className="text-2xl">{activity.title}</CardTitle>
              <CardDescription>由 {activity.host_name} 发起</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">时间</p>
            <p className="text-base">{format(new Date(activity.starts_at), "PPP p", { locale: zhCN })}</p>
          </div>
          <Separator />
          <div>
            <p className="text-sm text-muted-foreground">地点</p>
            <p className="text-base">📍 {activity.location}</p>
          </div>
          <Separator />
          <div>
            <p className="text-sm text-muted-foreground">人数</p>
            <p className="text-base">上限 {activity.capacity} 人</p>
          </div>
          <Separator />
          <Button className="w-full" size="lg">报名参加</Button>
        </CardContent>
      </Card>
    </main>
  )
}
