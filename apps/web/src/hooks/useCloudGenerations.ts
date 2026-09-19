import type { GenerationPage } from '@image-playground/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedBffFetch } from '../lib/authClient'
import { scopedStorageName } from '../lib/authScope'
import { mirrorGenerations } from '../lib/cloudMirror'
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
 * 作品页的平台记录：读到之后直接并进本机历史（`mirrorGenerations`），不单独渲染成另一种卡。
 *
 * 按游标往后累积而不是翻页：作品页只有一条时间线，本机任务不分页，翻页会把它切断。
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
        await mirrorGenerations(page.items)
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
