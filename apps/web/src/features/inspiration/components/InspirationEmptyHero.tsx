import { useMemo } from 'react'
import { SparkleIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { pickFeaturedInspirations } from '../lib/pickFeatured'
import { useInspirationStore } from '../store'
import InspirationCard from './InspirationCard'

const FEATURED_COUNT = 3

export default function InspirationEmptyHero() {
  const items = useInspirationStore((s) => s.items)
  const openPanel = useInspirationStore((s) => s.openPanel)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)

  const featured = useMemo(
    () => pickFeaturedInspirations(items, pinnedIds, FEATURED_COUNT),
    [items, pinnedIds],
  )

  if (featured.length < FEATURED_COUNT) return null

  return (
    <div className="py-10 sm:py-14">
      <div className="mb-6 text-center sm:mb-8">
        <h2 className="font-display text-lg font-medium tracking-wide text-gray-800 dark:text-gray-100 sm:text-xl">
          不知道画什么？挑一张开始
        </h2>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 sm:text-sm">
          灵感库 {items.length} 条精选，点击直接套用
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {featured.map((item) => (
          <InspirationCard
            key={item.id}
            item={item}
            pinned={pinnedIds.includes(item.id)}
            onClick={() => applyInspiration(item)}
          />
        ))}
        <OpenInspirationCta onClick={openPanel} totalCount={items.length} />
      </div>
    </div>
  )
}

function OpenInspirationCta({ onClick, totalCount }: { onClick: () => void; totalCount: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`打开灵感库，共 ${totalCount} 条`}
      className="group relative flex aspect-[3/4] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-gray-200/60 bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 text-center transition-all duration-300 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-400/60 dark:border-white/[0.06] dark:from-blue-500/[0.10] dark:via-purple-500/[0.10] dark:to-pink-500/[0.10] dark:hover:border-blue-500/40 dark:hover:shadow-blue-500/10"
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-8 -top-8 h-32 w-32 rounded-full bg-blue-300/60 blur-3xl dark:bg-blue-500/30" />
        <div className="absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-pink-300/60 blur-3xl dark:bg-pink-500/30" />
      </div>

      <div className="relative flex flex-col items-center gap-3 px-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/85 shadow-sm transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6 dark:bg-white/10">
          <SparkleIcon className="h-7 w-7 text-blue-500 dark:text-blue-300" />
        </div>
        <div>
          <div className="font-display text-sm font-semibold tracking-wide text-gray-800 dark:text-gray-100">
            探索更多
          </div>
          <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            共 {totalCount} 条灵感
          </div>
        </div>
      </div>
    </button>
  )
}
