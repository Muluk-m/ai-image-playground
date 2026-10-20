import { useEffect, useState } from 'react'
import SectionHeader from '../../../components/patterns/SectionHeader'
import { Icon } from '../../../components/ui/icon'
import heroSeedData from '../../../generated/heroSeed.json'
import { useTranslation } from '../../../i18n'
import { openInspiration } from '../lib/navigate'
import { createSeed, inspirationFeedOrder } from '../lib/seededShuffle'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import HomeInspirationFeed from './HomeInspirationFeed'
import InspirationSkeleton from './InspirationSkeleton'

// 完整清单不可用时保留离线示例。
const HERO_SEED = heroSeedData as InspirationItem[]

/**
 * 创作页还没有作品时的灵感区。顺序在清单落地时洗牌一次：
 * 收藏、滚动和随后的清单刷新都不改这串顺序。
 */
export default function InspirationEmptyHero() {
  const available = useInspirationStore((state) => state.items)
  const status = useInspirationStore((state) => state.status)
  const loadRemote = useInspirationStore((state) => state.loadRemote)
  const [seed] = useState(createSeed)
  const [ordered, setOrdered] = useState<InspirationItem[] | null>(null)
  const { t } = useTranslation('inspiration')

  useEffect(() => {
    void loadRemote()
  }, [loadRemote])

  useEffect(() => {
    if (ordered || (status !== 'ready' && status !== 'error')) return
    const source = available.length > 0 ? available : status === 'error' ? HERO_SEED : []
    setOrdered(inspirationFeedOrder(source, seed))
  }, [available, ordered, seed, status])

  return (
    <div className="py-8 sm:py-10">
      <SectionHeader
        className="mb-4"
        icon={<Icon name="explore" className="text-primary" />}
        title={t('hero.title')}
        action={{ label: t('hero.viewAll'), onClick: openInspiration }}
      />
      {ordered === null ? <InspirationSkeleton label={t('list.loading')} /> : null}
      {ordered?.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">{t('list.empty')}</p>
      ) : null}
      {ordered && ordered.length > 0 ? <HomeInspirationFeed items={ordered} /> : null}
    </div>
  )
}
