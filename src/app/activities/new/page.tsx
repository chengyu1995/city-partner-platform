"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { createActivityAction } from "./actions"
import { validateOnClient } from "./client-validate"
import type { ActivityFormErrors } from "@/types/db"

export default function NewActivityPage() {
  const router = useRouter()
  const [errors, setErrors] = useState<ActivityFormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  async function handleSubmit(formData: FormData) {
    setServerError(null)
    const input = {
      title:      String(formData.get("title") ?? ""),
      starts_at:  String(formData.get("starts_at") ?? ""),
      location:   String(formData.get("location") ?? ""),
      capacity:   Number(formData.get("capacity") ?? 0),
      host_name:  String(formData.get("host_name") ?? ""),
    }

    // 客户端预校验
    const clientErrors = validateOnClient(input)
    setErrors(clientErrors)
    if (Object.keys(clientErrors).length > 0) return

    setSubmitting(true)
    const result = await createActivityAction(input)
    setSubmitting(false)

    if (!result.ok) {
      setServerError(result.error)
      return
    }
    router.push(`/activities/${result.id}`)
  }

  return (
    <main className="container max-w-2xl py-10">
      <Card>
        <CardHeader>
          <CardTitle>发起活动</CardTitle>
          <CardDescription>填好下面 5 项，活动会立刻出现在活动列表里</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="title">标题</Label>
              <Input id="title" name="title" placeholder="比如：周末飞盘局" />
              {errors.title && <p className="text-sm text-destructive">{errors.title}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="starts_at">开始时间</Label>
              <Input id="starts_at" name="starts_at" type="datetime-local" />
              {errors.starts_at && <p className="text-sm text-destructive">{errors.starts_at}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="location">地点</Label>
              <Input id="location" name="location" placeholder="比如：朝阳公园南门" />
              {errors.location && <p className="text-sm text-destructive">{errors.location}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="capacity">人数上限</Label>
                <Input id="capacity" name="capacity" type="number" min={1} max={1000} defaultValue={10} />
                {errors.capacity && <p className="text-sm text-destructive">{errors.capacity}</p>}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="host_name">发起人</Label>
                <Input id="host_name" name="host_name" placeholder="你的昵称" />
                {errors.host_name && <p className="text-sm text-destructive">{errors.host_name}</p>}
              </div>
            </div>
            {serverError && (
              <p className="text-sm text-destructive border border-destructive rounded-md p-2">
                {serverError}
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "提交中..." : "发起活动"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
