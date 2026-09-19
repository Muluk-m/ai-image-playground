import { useEffect, useRef, useState } from 'react'
import { SparkleIcon } from '../../../components/icons'
import heroSeedData from '../../../generated/heroSeed.json'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { HERO_CARD_COUNT, rotateHeroItems } from '../lib/heroRotation'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'

// 完整清单不可用时保留离线示例。
const HERO_SEED = heroSeedData as InspirationItem[]

export default function InspirationEmptyHero() {
  const openPanel = useInspirationStore((s) => s.openPanel)
  const available = useInspirationStore((s) => s.items)
  const status = useInspirationStore((s) => s.status)
  const loadRemote = useInspirationStore((s) => s.loadRemote)
  const [items, setItems] = useState<InspirationItem[]>([])
  const selected = useRef(false)
  useEffect(() => {
    void loadRemote()
  }, [loadRemote])
  useEffect(() => {
    // 每次进入只选一批，收藏、输入和后台清单更新都不会让卡片跳动。
    if (selected.current || (!available.length && status !== 'ready' && status !== 'error')) return
    selected.current = true
    setItems(rotateHeroItems(available.length ? available : HERO_SEED))
  }, [available, status])
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)
  const { t } = useTranslation('inspiration')

  return (
    <div className="py-8 sm:py-10">
      <div className="mb-4 flex items-center justify-between gap-3 sm:mb-5">
        <h2 className="font-display inline-flex items-center gap-1.5 text-sm font-medium tracking-wide text-primary sm:text-base">
          <SparkleIcon className="h-4 w-4" aria-hidden />
          {t('hero.title')}
        </h2>
        <button
          type="button"
          onClick={openPanel}
          className="group inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:text-foreground sm:text-sm"
        >
          {t('hero.viewAll')}
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
          {items.length === 0 &&
            Array.from({ length: HERO_CARD_COUNT }, (_, index) => (
              <div
                key={index}
                aria-hidden
                className="w-[42%] flex-shrink-0 snap-start sm:w-auto sm:flex-shrink"
              >
                <div className="aspect-[3/4] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
              </div>
            ))}
          {items.map((item) => (
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
