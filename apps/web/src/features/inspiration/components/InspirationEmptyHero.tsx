import { SparkleIcon } from '../../../components/icons'
import heroSeedData from '../../../generated/heroSeed.json'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'

// build 期由 scripts/build-hero-seed.mjs 从 manifest 提取，硬编码到 bundle。
// 首屏立即可见，不依赖 manifest fetch。
const HERO_SEED = heroSeedData as InspirationItem[]

export default function InspirationEmptyHero() {
  const openPanel = useInspirationStore((s) => s.openPanel)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)

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

      {/*
        移动端：6 张横向 snap 滚动，每张占 42% 宽度，第三张露一半提示可以继续滑。
        -mx-4 + px-4 是反向出血到父容器 safe-area-x 边界，让滑动条贴边、
        起止位置不被父 padding 切。sm 起切到 grid，wrapper 子 div 透明传递宽度。
      */}
      <div className="-mx-4 overflow-x-auto hide-scrollbar sm:mx-0 sm:overflow-x-visible">
        <div className="flex snap-x snap-mandatory gap-3 px-4 sm:grid sm:snap-none sm:grid-cols-3 sm:gap-3.5 sm:px-0 lg:grid-cols-6">
          {HERO_SEED.map((item) => (
            <div
              key={item.id}
              className="w-[42%] flex-shrink-0 snap-start sm:w-auto sm:flex-shrink"
            >
              <InspirationCard
                item={item}
                pinned={pinnedIds.includes(item.id)}
                onClick={() => applyInspiration(item)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
