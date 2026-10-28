import { useEffect, useMemo, useState } from 'react'
import SectionHeader from '../../../components/patterns/SectionHeader'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import heroSeedData from '../../../generated/heroSeed.json'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { groupOf, INSPIRATION_GROUPS, type InspirationGroupId } from '../lib/groups'
import { openInspiration } from '../lib/navigate'
import { createSeed, inspirationFeedOrder } from '../lib/seededShuffle'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'
import InspirationSkeleton from './InspirationSkeleton'

// 完整清单不可用时保留离线示例。
const HERO_SEED = heroSeedData as InspirationItem[]
/** 首页只放两行，想看更多去灵感页。 */
export const HOME_INSPIRATION_LIMIT = 8

/**
 * 首页灵感区：分组页签 + 固定 4:5 的两行网格。顺序在清单落地时洗牌一次，
 * 收藏和随后的清单刷新都不改这串顺序；分组只在本区内筛选，不动灵感页的筛选。
 */
export default function HomeInspirationSection() {
  const available = useInspirationStore((state) => state.items)
  const status = useInspirationStore((state) => state.status)
  const loadRemote = useInspirationStore((state) => state.loadRemote)
  const showDetail = useInspirationStore((state) => state.showDetail)
  const pinnedIds = useStore((state) => state.pinnedInspirationIds)
  const [seed] = useState(createSeed)
  const [ordered, setOrdered] = useState<InspirationItem[] | null>(null)
  const [group, setGroup] = useState<InspirationGroupId | null>(null)
  const { t } = useTranslation('inspiration')

  useEffect(() => {
    void loadRemote()
  }, [loadRemote])

  useEffect(() => {
    if (ordered || (status !== 'ready' && status !== 'error')) return
    const source = available.length > 0 ? available : status === 'error' ? HERO_SEED : []
    setOrdered(inspirationFeedOrder(source, seed))
  }, [available, ordered, seed, status])

  const groups = useMemo(() => {
    const present = new Set((ordered ?? []).map((item) => groupOf(item.category)))
    return INSPIRATION_GROUPS.filter((one) => present.has(one.id))
  }, [ordered])
  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const shown = (ordered ?? [])
    .filter((item) => !group || groupOf(item.category) === group)
    .slice(0, HOME_INSPIRATION_LIMIT)

  const tab = (id: InspirationGroupId | null, label: string, count?: number) => (
    <Button
      key={id ?? 'all'}
      type="button"
      size="xs"
      variant="ghost"
      aria-pressed={group === id}
      className={`shrink-0 ${group === id ? 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary' : 'text-muted-foreground'}`}
      onClick={() => setGroup(id)}
    >
      {label}
      {count === undefined ? null : (
        <span className="font-mono text-label-sm opacity-70">{count}</span>
      )}
    </Button>
  )

  return (
    <section className="pb-8 pt-12 sm:pb-10" aria-label={t('hero.title')}>
      <SectionHeader
        className="mb-4"
        icon={<Icon name="explore" className="text-primary" />}
        title={t('hero.title')}
        link={{ label: t('hero.viewAll'), onClick: openInspiration }}
      >
        {groups.length > 0 ? (
          <div
            role="group"
            aria-label={t('filter.groups')}
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            {tab(null, t('filter.all'), ordered?.length)}
            {groups.map((one) => tab(one.id, t(`group.${one.id}`)))}
          </div>
        ) : null}
      </SectionHeader>
      {ordered === null ? <InspirationSkeleton label={t('list.loading')} /> : null}
      {ordered?.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">{t('list.empty')}</p>
      ) : null}
      {shown.length > 0 ? (
        <div data-testid="home-inspiration-grid" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {shown.map((item) => (
            <div key={item.id} data-inspiration-id={item.id} className="min-w-0">
              <InspirationCard
                item={item}
                pinned={pinned.has(item.id)}
                aspect="4 / 5"
                onClick={() => {
                  showDetail(item.id, item)
                  openInspiration()
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
