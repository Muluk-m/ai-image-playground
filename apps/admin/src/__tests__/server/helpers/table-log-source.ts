import type { createDb } from '@image-playground/db'
import { sql } from 'drizzle-orm'
import type { LegacyLogRow } from '../../../../server/lib/server-log-source'

/**
 * 概览错误面板的规则测试用 `server_logs` 表当日志来源：用例照旧插表，规则 SQL 拿到的行和
 * 生产从 OpenObserve 转出来的行形状相同（OpenObserve 一侧的转换与端到端用例见
 * server-log-source.test.ts）。取行的范围和生产相同。
 *
 * 服务端模块在调用时才加载：测试文件要先设好环境变量。
 */
export async function useTableLogSource(writer: ReturnType<typeof createDb>): Promise<void> {
  const { _setServerLogSourceForTesting } = await import('../../../../server/lib/server-log-source')
  _setServerLogSourceForTesting({
    // 和生产从 OpenObserve 取的范围一致：错误，加上 cloudflared 的注册、断开与 Serve tunnel error；
    // 原因行按请求另查。
    async logs(from, to, options = {}) {
      const rows = await writer.db.execute(sql`
        SELECT id, at, service, instance, version, level, event, group_key, message, request_id,
          task_id, fields
        FROM server_logs WHERE at >= ${new Date(from)} AND at <= ${new Date(to)}
          AND (level IN ('error', 'fatal') OR (${!options.errorsOnly} AND service = 'cloudflared' AND (
            message LIKE '%Registered tunnel connection%' OR message LIKE '%Serve tunnel error%'
            OR message LIKE '%Lost connection with the edge%')))
      `)
      return { rows: rows as unknown as LegacyLogRow[], availability: 'complete' }
    },
    async causes(requestIds, from, to) {
      if (requestIds.length === 0) return []
      const rows = await writer.db.execute(sql`
        SELECT id, at, service, instance, version, level, event, group_key, message, request_id,
          task_id, fields
        FROM server_logs WHERE at >= ${new Date(from)} AND at <= ${new Date(to)}
          AND request_id IN (${sql.join(
            requestIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND (fields ? 'errorCode' OR fields ? 'reason' OR fields ? 'err' OR fields ? 'error')
      `)
      return rows as unknown as LegacyLogRow[]
    },
  })
}
