import { useEffect, useMemo } from 'react'
import { SparkleIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { pickFeaturedInspirations } from '../lib/pickFeatured'
import { useInspirationStore } from '../store'
import InspirationCard from './InspirationCard'

const FEATURED_COUNT = 6
// hero 默认只从 GPT Image 2 池里挑：那 423 条来自 awesome-gpt-image-2，
// 多数是设计参考级的高质量图，banana 池的手机截图风格不上首屏。
// pinned 不受此限制（用户显式偏好优先）。
const HERO_PREFERRED_PROVIDER = 'openai-compat' as const

export default function InspirationEmptyHero() {
  const items = useInspirationStore((s) => s.items)
  const status = useInspirationStore((s) => s.status)
  const loadRemote = useInspirationStore((s) => s.loadRemote)
  const openPanel = useInspirationStore((s) => s.openPanel)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)

  useEffect(() => {
    // hero 进入即触发 manifest 加载；store 内部对 in-flight / 已加载做了幂等保护，
    // 与 coach / openPanel 共享同一份请求，不会重复 fetch 872KB。
    void loadRemote()
  }, [loadRemote])

  const featured = useMemo(
    () =>
      pickFeaturedInspirations(items, pinnedIds, FEATURED_COUNT, Date.now(), {
        preferredProvider: HERO_PREFERRED_PROVIDER,
      }),
    [items, pinnedIds],
  )

  const ready = featured.length >= FEATURED_COUNT
  const fetchFailed = status === 'error' && items.length === 0

  if (fetchFailed) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        <p className="text-sm">输入提示词开始生成图片</p>
      </div>
    )
  }

  return (
    <div className="py-8 sm:py-10">
      <div className="mb-4 flex items-center justify-between gap-3 sm:mb-5">
        <h2 className="font-display inline-flex items-center gap-1.5 text-sm font-medium tracking-wide text-blue-600 dark:text-blue-300 sm:text-base">
          <SparkleIcon className="h-4 w-4" aria-hidden />
          灵感探索
        </h2>
        <button
          type="button"
          onClick={openPanel}
          className="group inline-flex items-center gap-0.5 text-xs text-gray-500 transition-colors hover:text-gray-800 focus:outline-none focus-visible:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 dark:focus-visible:text-gray-100 sm:text-sm"
        >
          查看全部
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3.5 lg:grid-cols-6">
        {ready
          ? featured.map((item) => (
              <InspirationCard
                key={item.id}
                item={item}
                pinned={pinnedIds.includes(item.id)}
                onClick={() => applyInspiration(item)}
              />
            ))
          : Array.from({ length: FEATURED_COUNT }).map((_, i) => (
              // 顺序固定且数量固定，key=index 安全且稳定，没有重排场景。
              // biome-ignore lint/suspicious/noArrayIndexKey: stable placeholder list
              <HeroSkeletonCard key={i} />
            ))}
      </div>
    </div>
  )
}

function HeroSkeletonCard() {
  return (
    <div
      aria-hidden
      className="relative flex aspect-[3/4] w-full flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-gray-50/40 dark:border-white/[0.06] dark:bg-white/[0.02]"
    >
      <div className="h-full w-full animate-pulse bg-gradient-to-br from-gray-200/60 via-gray-200/40 to-gray-100/40 dark:from-white/[0.06] dark:via-white/[0.03] dark:to-white/[0.04]" />
    </div>
  )
}
