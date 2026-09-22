import { useEffect, useMemo } from 'react'
import { useTranslation } from '../../../i18n'
import { applyInspiration } from '../lib/applyInspiration'
import { openInspiration } from '../lib/navigate'
import { useInspirationStore } from '../store'

const COUNT = 4

/** 每次进首屏随机换一批，不然永远是清单前四条。Fisher–Yates 取前 COUNT 个。 */
function sample<T>(items: readonly T[], count: number): T[] {
  const pool = [...items]
  for (let at = pool.length - 1; at > 0; at--) {
    const pick = Math.floor(Math.random() * (at + 1))
    ;[pool[at], pool[pick]] = [pool[pick]!, pool[at]!]
  }
  return pool.slice(0, count)
}

/**
 * 输入框下面那排起手 chip：缩略图 + 标题，点一下把灵感的提示词与参数套进输入框。
 * 数据就是灵感清单本身，不另造一份运营文案。
 */
export default function InspirationChips() {
  const items = useInspirationStore((state) => state.items)
  const { t } = useTranslation('inspiration')
  const picked = useMemo(() => sample(items, COUNT), [items])

  useEffect(() => {
    void useInspirationStore.getState().loadRemote()
  }, [])

  if (items.length === 0) return null

  return (
    <div className="-mx-4 flex items-center gap-2.5 overflow-x-auto px-4 pt-5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0">
      {picked.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => applyInspiration(item)}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-border bg-card/70 py-1.5 pl-1.5 pr-3.5 text-[13px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-7 w-10 rounded-lg object-cover"
          />
          <span className="max-w-[12rem] truncate">{item.title}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={openInspiration}
        className="shrink-0 rounded-xl border border-border px-3.5 py-2.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
      >
        {t('hero.viewAll')} →
      </button>
    </div>
  )
}
