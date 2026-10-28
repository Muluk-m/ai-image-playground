import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { applyInspiration } from '../lib/applyInspiration'
import { inspirationTitle } from '../lib/labels'
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
  const rowRef = useRef<HTMLDivElement>(null)
  // 手机上这排横滑；右边还有没露出来的 chip 时把右缘渐隐，划到底就收掉。
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const row = rowRef.current
    if (!row) return
    setMore(row.scrollLeft + row.clientWidth < row.scrollWidth - 1)
  }, [])

  useEffect(() => {
    void useInspirationStore.getState().loadRemote()
  }, [])

  useEffect(() => {
    const row = rowRef.current
    if (!row || picked.length === 0 || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const chip of row.children) observer.observe(chip)
    return () => observer.disconnect()
  }, [picked, measure])

  if (items.length === 0) return null

  return (
    <div
      ref={rowRef}
      onScroll={measure}
      data-more={more || undefined}
      className="studio-home-chips -mx-4 flex items-center gap-2.5 overflow-x-auto px-4 pt-5 [scrollbar-width:none] data-[more]:[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)] sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 sm:data-[more]:[mask-image:none]"
    >
      {picked.map((item) => (
        <Button
          key={item.id}
          type="button"
          onClick={() => applyInspiration(item)}
          variant="outline"
          size="lg"
          className="shrink-0 px-2 text-body-sm text-muted-foreground"
        >
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="studio-home-chip-thumb h-7 w-10 rounded-lg object-cover"
          />
          <span className="max-w-[12rem] truncate">{inspirationTitle(item)}</span>
        </Button>
      ))}
      <Button
        type="button"
        onClick={openInspiration}
        variant="outline"
        size="lg"
        className="group shrink-0 px-3 text-body-sm text-muted-foreground"
      >
        {t('hero.viewAll')}
        <Icon name="arrowRight" className="transition-transform group-hover:translate-x-0.5" />
      </Button>
    </div>
  )
}
