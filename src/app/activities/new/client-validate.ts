"use client"

/**
 * 客户端校验 —— 必须从 "use client" 文件 export 普通函数
 * 服务端 action 文件（"use server"）只允许 export async function
 */
import { validateActivityInput } from "@/lib/db"
import type { ActivityFormErrors } from "@/types/db"

export function validateOnClient(input: Partial<import("@/types/db").NewActivity>): ActivityFormErrors {
  return validateActivityInput(input)
}
