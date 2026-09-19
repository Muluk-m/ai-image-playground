import { useEffect, useMemo, useRef, useState } from 'react'
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

const ALL_CATEGORIES = '__all__'
/** 分类多了就换行挤掉瀑布流，取出现频次靠前的几个。 */
const MAX_CATEGORY_TABS = 6

// 示例的 params.size 多数是 auto，问不出画幅，所以瀑布流的高度直接由缩略图自己决定。

function topCategories(items: readonly InspirationItem[]): string[] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CATEGORY_TABS)
    .map(([category]) => category)
}

/**
 * 作品页空态的灵感区：瀑布流按每条示例自己的画幅排，分类页签就地筛，不用进灵感库面板。
 * 点一张卡把提示词填进页面顶部的输入框并滚回去——填了看不见等于没填。
 */
export default function InspirationEmptyHero() {
  const openPanel = useInspirationStore((s) => s.openPanel)
  const available = useInspirationStore((s) => s.items)
  const status = useInspirationStore((s) => s.status)
  const loadRemote = useInspirationStore((s) => s.loadRemote)
  const [rotated, setRotated] = useState<InspirationItem[]>([])
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const selected = useRef(false)
  useEffect(() => {
    void loadRemote()
  }, [loadRemote])
  useEffect(() => {
    // 每次进入只选一批，收藏、输入和后台清单更新都不会让卡片跳动。
    if (selected.current || (!available.length && status !== 'ready' && status !== 'error')) return
    selected.current = true
    setRotated(rotateHeroItems(available.length ? available : HERO_SEED))
  }, [available, status])
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)
  const { t } = useTranslation('inspiration')

  const pool = available.length ? available : HERO_SEED
  const categories = useMemo(() => topCategories(pool), [pool])
  const items = useMemo(
    () =>
      category === ALL_CATEGORIES
        ? rotated
        : pool.filter((item) => item.category === category).slice(0, HERO_CARD_COUNT),
    [category, pool, rotated],
  )

  const apply = (item: InspirationItem) => {
    applyInspiration(item, () => window.scrollTo({ top: 0, behavior: 'smooth' }))
  }

  const tab = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={category === value}
      onClick={() => setCategory(value)}
      className={`shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors sm:text-sm ${
        category === value
          ? 'bg-foreground/10 font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="pb-10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-medium tracking-tight sm:text-lg">
          {t('hero.title')}
        </h2>
        <button
          type="button"
          onClick={openPanel}
          className="group inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:text-foreground sm:text-sm"
        >
          {t('hero.viewAll')}
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </button>
      </div>

      <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 hide-scrollbar sm:mx-0 sm:px-0">
        {tab(ALL_CATEGORIES, t('hero.all'))}
        {categories.map((name) => tab(name, name))}
      </div>

      {/* 瀑布流用 CSS 多列：卡片各自的画幅决定高度，列内自上而下排。 */}
      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5">
        {items.length === 0 &&
          Array.from({ length: HERO_CARD_COUNT }, (_, index) => (
            <div key={index} aria-hidden className="mb-3 break-inside-avoid">
              <div
                className="animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"
                style={{ aspectRatio: index % 3 === 1 ? '1 / 1' : '3 / 4' }}
              />
            </div>
          ))}
        {items.map((item) => (
          <div key={item.id} className="mb-3 break-inside-avoid">
            <InspirationCard
              item={item}
              pinned={pinnedIds.includes(item.id)}
              naturalHeight
              onClick={() => apply(item)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
