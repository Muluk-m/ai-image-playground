import type { LegacyLogRow } from '../../../../server/lib/server-log-source'

export interface MemoryLogInput {
  id: string
  at: number
  service: string
  instance: string
  version: string
  level: string
  event?: string | null
  group_key: string
  message: string
  request_id?: string | null
  task_id?: string | null
  fields: Record<string, unknown>
}

export interface MemoryLogSourceHandle {
  insert(rows: readonly MemoryLogInput[]): void
  clear(): void
}

const CAUSE_FIELD_KEYS = ['errorCode', 'reason', 'err', 'error'] as const

/**
 * 概览错误面板与规则测试的内存日志来源（替代已退场的 PG `server_logs` 表）：
 * 过滤范围与生产 OpenObserve 拉取范围一致，返回 `LegacyLogRow` 经同名 CTE 交给规则 SQL。
 *
 * 服务端模块在调用时才加载：测试文件要先设好环境变量。
 */
export async function useMemoryLogSource(): Promise<MemoryLogSourceHandle> {
  const { _setServerLogSourceForTesting } = await import('../../../../server/lib/server-log-source')
  const stored: Array<{ atMs: number; row: LegacyLogRow }> = []

  _setServerLogSourceForTesting({
    async logs(from, to, options = {}) {
      const rows = stored
        .filter(({ atMs, row }) => {
          if (atMs < from || atMs > to) return false
          if (row.level === 'error' || row.level === 'fatal') return true
          if (!options.errorsOnly && row.service === 'cloudflared') {
            return (
              row.message.includes('Registered tunnel connection') ||
              row.message.includes('Serve tunnel error') ||
              row.message.includes('Lost connection with the edge')
            )
          }
          return false
        })
        .map(({ row }) => row)
      return { rows, availability: 'complete' }
    },
    async causes(requestIds, from, to) {
      if (requestIds.length === 0) return []
      const wanted = new Set(requestIds)
      return stored
        .filter(({ atMs, row }) => {
          if (atMs < from || atMs > to) return false
          if (!row.request_id || !wanted.has(row.request_id)) return false
          return CAUSE_FIELD_KEYS.some((key) => Object.hasOwn(row.fields, key))
        })
        .map(({ row }) => row)
    },
  })

  return {
    insert(rows) {
      for (const input of rows) {
        stored.push({
          atMs: input.at,
          row: {
            id: input.id,
            at: new Date(input.at).toISOString(),
            service: input.service,
            instance: input.instance,
            version: input.version,
            level: input.level,
            event: input.event ?? null,
            group_key: input.group_key,
            message: input.message,
            request_id: input.request_id ?? null,
            task_id: input.task_id ?? null,
            fields: input.fields,
          },
        })
      }
    },
    clear() {
      stored.length = 0
    },
  }
}
