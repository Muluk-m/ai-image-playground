import { and, eq } from 'drizzle-orm'
import { config } from '../config'
import { schema } from '../db/client'

/**
 * 认证开启时，任务 ID 与账号 ID 必须同时命中。认证关闭时保持原来的仅 ID 行为。
 * 外部路由统一用这个条件，避免二进制图片或取消端点漏掉 ownership 检查。
 */
export function taskAccessWhere(taskId: string, userId: string | null) {
  return config.auth.enabled
    ? and(eq(schema.tasks.id, taskId), eq(schema.tasks.user_id, userId ?? '__unauthenticated__'))
    : eq(schema.tasks.id, taskId)
}
