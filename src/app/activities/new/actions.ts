"use server"

/**
 * Server Action：创建活动
 * - 客户端 form action 调用
 * - 二次校验（防客户端绕过）
 * - 调业务层 createActivity
 */
import { createActivity, validateActivityInput } from "@/lib/db"
import type { NewActivity, ActivityFormErrors } from "@/types/db"

type ActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; errors?: ActivityFormErrors }

export async function createActivityAction(input: NewActivity): Promise<ActionResult> {
  // 1) 服务端二次校验
  const errors = validateActivityInput(input)
  if (Object.keys(errors).length > 0) {
    return { ok: false, error: "表单字段不合法", errors }
  }

  // 2) 调数据层
  try {
    const row = await createActivity(input)
    return { ok: true, id: row.id }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}
