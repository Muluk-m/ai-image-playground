import type { MouseEvent } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { InspirationItem } from '../types'

interface Props {
  item: InspirationItem
  pinned: boolean
  onClick: () => void
}

/**
 * 打开案例的是一张铺满卡片的真实按钮，置顶按钮是它的兄弟节点。
 * 不能把按钮套进 role=button：嵌套交互控件是无效 HTML，无障碍树会乱。
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

  return (
    <article
      title={t('card.titleHint', { title: item.title, model: item.recommendedModel })}
      className="group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-lg focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        aria-label={item.title}
        className="absolute inset-0 z-0 h-auto rounded-2xl p-0 hover:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <div className="pointer-events-none relative z-[1] flex h-full w-full flex-col">
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
                <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-1 text-label-sm font-medium text-white">
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
                <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-1 text-label-sm font-medium text-white">
                  {t('card.after')}
                </span>
              </div>
            </div>
          ) : (
            <img
              src={item.thumbnailUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            />
          )}
        </div>

        <div className="flex flex-1 flex-col px-3.5 pb-3.5 pt-3">
          <span className="mb-2 inline-flex w-fit max-w-full truncate rounded-full bg-secondary px-2.5 py-1 text-label-sm font-medium text-secondary-foreground">
            {reference ? t('card.imageEdit') : item.category}
          </span>
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
            <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary max-md:min-h-11">
              {t('card.viewCase')}
              <Icon name="arrowRight" size="xs" />
            </span>
          </div>
        </div>
      </div>

      <Button
        type="button"
        onClick={handlePinClick}
        aria-pressed={pinned}
        aria-label={pinned ? t('card.unpin') : t('card.pin')}
        variant="secondary"
        size="icon-xs"
        className={`absolute right-2 top-2 z-10 size-11 md:size-7 ${pinned ? 'text-primary' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'}`}
      >
        <Icon name="favorite" filled={pinned} />
      </Button>
    </article>
  )
}
