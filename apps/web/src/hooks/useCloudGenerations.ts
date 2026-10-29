import type { GenerationPage } from '@image-playground/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedBffFetch } from '../lib/authClient'
import { scopedStorageName } from '../lib/authScope'
import { receivePlatformPage } from '../lib/platformGenerations'
import { bffBaseUrl } from '../lib/runtimeConfig'
import { sourceOfRecord, type WorkSource, type WorksSnapshot } from '../lib/works'
import { useStore } from '../store'

const PAGE_SIZE = 50

export interface CloudGenerations {
  readonly loading: boolean
  readonly failed: boolean
  readonly hasMore: boolean
  /** 第一页带回的服务端总数，以及之后确认过存在的记录；页签计数用它，不按翻到的条数数。 */
  readonly snapshot: WorksSnapshot | null
  loadMore(): void
  reload(): void
}

/**
 * 作品页的平台记录：读到之后进一份可整体替换的缓存（`lib/platformGenerations`），不写成本机任务。
 *
 * 按游标往后累积而不是翻页：作品页只有一条时间线，本机任务不分页，翻页会把它切断。
 * 每一页都带着它覆盖的时间上界交给缓存——平台在这个窗口里是权威，窗口内它没返回的记录就是已经删了。
 * 账号命名空间一变就整份重读，不把上一个账号的记录并进来。
 */
export function useCloudGenerations(enabled: boolean): CloudGenerations {
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<WorksSnapshot | null>(null)
  const request = useRef<AbortController | null>(null)
  const scope = scopedStorageName('generation-history')

  const load = useCallback(
    async (next: string | null) => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      const current = () =>
        !controller.signal.aborted && scopedStorageName('generation-history') === scope
      setLoading(true)
      setFailed(false)
      const startedAt = Date.now()
      try {
        const query = next ? `&cursor=${encodeURIComponent(next)}` : ''
        const response = await authenticatedBffFetch(
          `${bffBaseUrl()}/api/generations?limit=${PAGE_SIZE}${query}`,
          { cache: 'no-store', signal: controller.signal },
        )
        if (!response.ok) throw new Error('load_failed')
        const page: GenerationPage = await response.json()
        if (!current()) return
        const { dropped } = await receivePlatformPage(page.items, {
          until: cursorCreatedAt(next),
          hasMore: page.nextCursor !== null,
        })
        if (!current()) return
        setCursor(page.nextCursor)
        const returned = page.items.map((item): [string, WorkSource] => [
          item.id,
          sourceOfRecord(item),
        ])
        if (!next && page.totals) {
          // 第一页：总数换新，已在缓存里的记录（第一页窗口内没返回的已经被丢掉）都算服务端确认过的。
          const known = new Map<string, WorkSource>(
            useStore
              .getState()
              .platformGenerations.map((row): [string, WorkSource] => [
                row.id,
                sourceOfRecord(row.record),
              ]),
          )
          for (const [id, source] of returned) known.set(id, source)
          setSnapshot({ totals: page.totals, known, at: startedAt })
        } else {
          setSnapshot((previous) => {
            if (!previous) return previous
            const known = new Map(previous.known)
            for (const id of dropped) known.delete(id)
            for (const [id, source] of returned) known.set(id, source)
            return { ...previous, known }
          })
        }
      } catch {
        if (current()) setFailed(true)
      } finally {
        if (current()) {
          request.current = null
          setLoading(false)
        }
      }
    },
    [scope],
  )

  useEffect(() => {
    if (!enabled) {
      setCursor(null)
      setSnapshot(null)
      return
    }
    void load(null)
    return () => request.current?.abort()
  }, [enabled, load])

  const loadMore = useCallback(() => {
    if (!request.current && cursor) void load(cursor)
  }, [cursor, load])

  return {
    loading,
    failed,
    hasMore: cursor !== null,
    snapshot,
    loadMore,
    reload: () => void load(null),
  }
}

/**
 * 游标是上一页最后一条的位置，也是这一页覆盖的时间上界。第一页没有上界；认不出来的游标
 * 按「窗口为空」处理——宁可留着一条已经删掉的卡，也不能因为看不懂边界就把没读到的记录抹掉。
 */
function cursorCreatedAt(cursor: string | null): number {
  if (!cursor) return Number.POSITIVE_INFINITY
  try {
    const decoded: unknown = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')))
    if (decoded && typeof decoded === 'object' && 'createdAt' in decoded) {
      const createdAt = decoded.createdAt
      if (typeof createdAt === 'number') return createdAt
    }
    return Number.NEGATIVE_INFINITY
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}
