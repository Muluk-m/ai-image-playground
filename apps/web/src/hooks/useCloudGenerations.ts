import type { GenerationPage, GenerationSummary } from '@image-playground/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedBffFetch } from '../lib/authClient'
import { scopedStorageName } from '../lib/authScope'
import { bffBaseUrl } from '../lib/runtimeConfig'

const PAGE_SIZE = 50

export interface CloudGenerations {
  /** 已读到的全部条目，按服务端顺序（新的在前）累积。 */
  readonly items: readonly GenerationSummary[]
  readonly loading: boolean
  readonly failed: boolean
  readonly hasMore: boolean
  loadMore(): void
  reload(): void
}

/**
 * 作品页的云端记录：按游标往后累积成一条列表，而不是上一页 / 下一页。
 *
 * 作品页只有一个列表，本机任务和平台任务穿插在一起，所以这里必须是「继续往下读」的形状；
 * 翻页会让穿插失去意义（本机任务不分页）。账号命名空间一变就整份丢掉重读，不把上一个账号的
 * 记录混进来。
 */
export function useCloudGenerations(enabled: boolean): CloudGenerations {
  const [items, setItems] = useState<readonly GenerationSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  const scope = scopedStorageName('generation-history')

  const load = useCallback(
    async (next: string | null, append: boolean) => {
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
        setItems((previous) => (append ? [...previous, ...page.items] : page.items))
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
      setItems([])
      setCursor(null)
      return
    }
    void load(null, false)
    return () => request.current?.abort()
  }, [enabled, load])

  return {
    items,
    loading,
    failed,
    hasMore: cursor !== null,
    loadMore: () => {
      if (!loading && cursor) void load(cursor, true)
    },
    reload: () => void load(null, false),
  }
}
