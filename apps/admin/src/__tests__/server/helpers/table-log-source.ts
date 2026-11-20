import type { createDb } from '@image-playground/db'
import { sql } from 'drizzle-orm'
import {
  _setServerLogSourceForTesting,
  type LegacyLogRow,
} from '../../../../server/lib/server-log-source'

/**
 * 概览错误面板的规则测试用 `server_logs` 表当日志来源：用例照旧插表，规则 SQL 拿到的行和
 * 生产从 OpenObserve 转出来的行形状相同（OpenObserve 一侧的转换见 server-log-source.test.ts）。
 */
export function useTableLogSource(writer: ReturnType<typeof createDb>): void {
  _setServerLogSourceForTesting(async (from, to) => {
    const rows = await writer.db.execute(sql`
      SELECT id, at, service, instance, version, level, event, group_key, message, request_id,
        task_id, fields
      FROM server_logs WHERE at >= ${new Date(from)} AND at <= ${new Date(to)}
    `)
    return rows as unknown as LegacyLogRow[]
  })
}
