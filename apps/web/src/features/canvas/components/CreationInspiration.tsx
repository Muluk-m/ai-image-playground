import { useEffect, useRef, useState } from 'react'
import heroSeedData from '../../../generated/heroSeed.json'
import { useTranslation } from '../../../i18n'
import { fillAgentComposer } from '../../agent/lib/composerFill'
import { HERO_CARD_COUNT, rotateHeroItems } from '../../inspiration/lib/heroRotation'
import { openInspiration } from '../../inspiration/lib/navigate'
import { useInspirationStore } from '../../inspiration/store'
import type { InspirationItem } from '../../inspiration/types'

/** 完整清单拉不到时的离线兜底，与灵感库空状态同一份种子。 */
const HERO_SEED = heroSeedData as InspirationItem[]

/**
 * 落地页图片档的起手案例：直接用灵感库的条目，有封面、有提示词。点一下把提示词填进输入框，
 * 不直接发送，也不改模型与参数——智能体那条路的参数由它自己定，套用灵感库的 size/model
 * 只会和它打架（灵感库原本那条 `applyInspiration` 是给直接生成的输入框用的）。
 */
export default function CreationInspiration() {
  const available = useInspirationStore((state) => state.items)
  const status = useInspirationStore((state) => state.status)
  const loadRemote = useInspirationStore((state) => state.loadRemote)
  const [items, setItems] = useState<InspirationItem[]>([])
  const picked = useRef(false)
  const { t } = useTranslation(['video', 'inspiration', 'agent'])

  useEffect(() => {
    void loadRemote()
  }, [loadRemote])

  useEffect(() => {
    // 每次进入只选一批：输入、收藏与后台清单刷新都不该让卡片跳来跳去。
    if (picked.current || (!available.length && status !== 'ready' && status !== 'error')) return
    picked.current = true
    setItems(rotateHeroItems(available.length ? available : HERO_SEED))
  }, [available, status])

  return (
    <div className="w-full">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {t('video:landing.cases')}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t('video:landing.casesHint')}
          </span>
        </h2>
        <button
          type="button"
          onClick={openInspiration}
          className="group inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:text-foreground"
        >
          {t('inspiration:hero.viewAll')}
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </button>
      </div>
      <ul
        aria-label={t('agent:suggestions.aria')}
        className="grid grid-cols-3 gap-3 sm:grid-cols-6"
      >
        {items.length === 0 &&
          Array.from({ length: HERO_CARD_COUNT }, (_, index) => (
            <li key={index} aria-hidden>
              <div className="aspect-[3/4] animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
            </li>
          ))}
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              data-prompt={item.prompt}
              title={item.title}
              onClick={() => fillAgentComposer(item.prompt)}
              className="group flex w-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-primary hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <span className="relative block aspect-[3/4] overflow-hidden bg-muted">
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
                />
                <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white backdrop-blur-sm">
                  {item.category}
                </span>
                <span className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/85 via-black/45 to-transparent opacity-0 transition duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="line-clamp-6 p-3 text-[11px] leading-relaxed text-white/95">
                    {item.prompt}
                  </span>
                </span>
              </span>
              <span className="line-clamp-2 px-3 py-2.5 text-sm font-medium leading-snug text-foreground transition group-hover:text-primary">
                {item.title}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
