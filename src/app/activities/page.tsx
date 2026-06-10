"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// TODO: 接入 Supabase 后从 server-side fetch
const MOCK = [
  { id: "1", title: "周末飞盘局", when: "周六 14:00", where: "朝阳公园", people: "6/10", host: "阿飞" },
  { id: "2", title: "咖啡读书会", when: "周日 10:00", where: "国贸", people: "3/6", host: "小满" },
  { id: "3", title: "夜跑 5km", when: "周三 20:00", where: "奥森南门", people: "8/12", host: "Tony" },
]

export default function ActivitiesPage() {
  const [openId, setOpenId] = useState<string | null>(null)
  const active = MOCK.find((a) => a.id === openId)
  return (
    <main className="container py-10">
      <h1 className="mb-2 text-3xl font-bold">活动列表</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        经典 shadcn/ui 风格（Slate 主题 + Radix Slot + asChild）
      </p>
      <Separator className="my-4" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MOCK.map((a) => (
          <Card key={a.id}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback>{a.host.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <div>
                  <CardTitle>{a.title}</CardTitle>
                  <CardDescription>由 {a.host} 发起</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{a.when} · {a.where}</p>
              <p className="mt-2 text-sm text-muted-foreground">已报名 {a.people}</p>
            </CardContent>
            <CardFooter>
              <Dialog open={openId === a.id} onOpenChange={(o) => setOpenId(o ? a.id : null)}>
                <DialogTrigger asChild>
                  <Button className="w-full">报名</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>报名：{a.title}</DialogTitle>
                    <DialogDescription>
                      {a.when} · {a.where} · 已报名 {a.people}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor={`name-${a.id}`}>昵称</Label>
                      <Input id={`name-${a.id}`} placeholder="你想怎么被称呼" />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={`phone-${a.id}`}>联系方式（选填）</Label>
                      <Input id={`phone-${a.id}`} placeholder="手机号 / 微信" />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setOpenId(null)}>取消</Button>
                    <Button onClick={() => setOpenId(null)}>确认报名</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardFooter>
          </Card>
        ))}
      </div>
    </main>
  )
}
