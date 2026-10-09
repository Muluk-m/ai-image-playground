import { ArrowRight } from 'lucide-react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { StarIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { InspirationItem } from '../types'

interface Props {
  item: InspirationItem
  pinned: boolean
  onClick: () => void
}

/**
 * 外层用 div+role="button" 而不是 <button>，因为内部含 pin 按钮（嵌套 <button>
 * 是 invalid HTML，浏览器会扁平化，accessibility tree 会错乱）。键盘 Enter/Space
 * 手动触发 onClick 维持原有 a11y 行为。
 */
export default function InspirationCard({ item, pinned, onClick }: Props) {
  const togglePin = useStore((s) => s.toggleInspirationPin)
  const { t } = useTranslation('inspiration')
  const reference = item.referenceImages?.[0]
  const referenceCount = item.referenceImages?.length ?? 0

  const handlePinClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    togglePin(item.id)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      title={t('card.titleHint', { title: item.title, model: item.recommendedModel })}
      className="group relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-border/70 bg-card text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div
        className={`relative overflow-hidden bg-muted ${reference ? 'aspect-[4/3]' : 'aspect-[3/4]'}`}
      >
        {reference ? (
          <div className="grid h-full grid-cols-2 gap-0.5 bg-border/70">
            <div className="relative min-w-0 overflow-hidden bg-muted">
              <img
                src={reference.url}
                alt={t('card.beforeAlt', { title: item.title })}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              />
              <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-2 py-1 text-label-sm font-medium text-white">
                {t('card.before')}
              </span>
            </div>
            <div className="relative min-w-0 overflow-hidden bg-muted">
              <img
                src={item.thumbnailUrl}
                alt={t('card.afterAlt', { title: item.title })}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              />
              <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-2 py-1 text-label-sm font-medium text-white">
                {t('card.after')}
              </span>
            </div>
          </div>
        ) : (
          <img
            src={item.thumbnailUrl}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
          />
        )}

        <span className="pointer-events-none absolute left-2 top-2 rounded-full border border-white/25 bg-black/60 px-2.5 py-1 text-label-sm font-medium text-white backdrop-blur-sm">
          {reference ? t('card.imageEdit') : item.category}
        </span>

        <button
          type="button"
          onClick={handlePinClick}
          aria-pressed={pinned}
          aria-label={pinned ? t('card.unpin') : t('card.pin')}
          className={`absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
            pinned
              ? 'bg-warning/90 text-white opacity-100 shadow-sm'
              : 'bg-black/45 text-white opacity-0 hover:bg-black/65 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
          }`}
        >
          <StarIcon width={14} height={14} filled={pinned} aria-hidden />
        </button>
      </div>

      <div className="flex flex-1 flex-col px-3.5 pb-3.5 pt-3">
        <div className="line-clamp-2 text-sm font-semibold leading-snug text-foreground transition group-hover:text-primary">
          {item.title}
        </div>
        {item.description && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-label-sm text-muted-foreground">
          <span className="truncate">
            {item.category}
            {referenceCount > 0 && ` · ${t('card.referenceCount', { count: referenceCount })}`}
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary">
            {t('card.viewCase')}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  )
}
