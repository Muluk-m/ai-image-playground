import type { GenerationPage } from '@image-playground/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedBffFetch } from '../lib/authClient'
import { scopedStorageName } from '../lib/authScope'
import { receivePlatformPage } from '../lib/platformGenerations'
import { bffBaseUrl } from '../lib/runtimeConfig'

const PAGE_SIZE = 50

export interface CloudGenerations {
  readonly loading: boolean
  readonly failed: boolean
  readonly hasMore: boolean
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
      try {
        const query = next ? `&cursor=${encodeURIComponent(next)}` : ''
        const response = await authenticatedBffFetch(
          `${bffBaseUrl()}/api/generations?limit=${PAGE_SIZE}${query}`,
          { cache: 'no-store', signal: controller.signal },
        )
        if (!response.ok) throw new Error('load_failed')
        const page: GenerationPage = await response.json()
        if (!current()) return
        await receivePlatformPage(page.items, {
          until: cursorCreatedAt(next),
          hasMore: page.nextCursor !== null,
        })
        if (!current()) return
        setCursor(page.nextCursor)
      } catch {
        if (current()) setFailed(true)
      } finally {
        if (current()) setLoading(false)
      }
    },
    [scope],
  )

  useEffect(() => {
    if (!enabled) {
      setCursor(null)
      return
    }
    void load(null)
    return () => request.current?.abort()
  }, [enabled, load])

  return {
    loading,
    failed,
    hasMore: cursor !== null,
    loadMore: () => {
      if (!loading && cursor) void load(cursor)
    },
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
