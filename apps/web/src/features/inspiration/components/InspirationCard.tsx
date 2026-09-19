import type { KeyboardEvent, MouseEvent } from 'react'
import { StarIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { InspirationItem } from '../types'

interface Props {
  item: InspirationItem
  pinned: boolean
  /** 瀑布流里让卡片高度跟着图片本身走；缺省是统一的竖版 3:4。 */
  naturalHeight?: boolean
  onClick: () => void
}

/**
 * 灵感卡：整张就是图，标题与分类压在底部渐变上，单行截断。
 *
 * 图上不再铺提示词——原先 hover 把整段 prompt 铺成六行小字，既读不动也把画面毁了；
 * 提示词在详情里看，卡片只负责「这是什么」。收藏星只在 hover / 键盘聚焦时浮出，
 * 静态画面上没有任何控件。
 *
 * 外层用 div+role="button" 而不是 <button>，因为内部含收藏按钮（嵌套 <button> 是
 * invalid HTML，浏览器会扁平化，accessibility tree 会错乱）。键盘 Enter/Space 手动
 * 触发 onClick 维持原有 a11y 行为。
 */
export default function InspirationCard({ item, pinned, naturalHeight, onClick }: Props) {
  const togglePin = useStore((s) => s.toggleInspirationPin)
  const { t } = useTranslation('inspiration')

  const handlePinClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    togglePin(item.id)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      className="group relative flex h-full w-full cursor-pointer overflow-hidden rounded-2xl border border-border/60 bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-[0_16px_32px_-18px_rgb(0_0_0/0.8)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={item.thumbnailUrl}
        alt={item.title}
        loading="lazy"
        className={`w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] ${
          naturalHeight ? 'h-auto' : 'aspect-[3/4]'
        }`}
      />

      <button
        type="button"
        onClick={handlePinClick}
        aria-pressed={pinned}
        aria-label={pinned ? t('card.unpin') : t('card.pin')}
        className={`absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
          pinned
            ? 'bg-warning text-warning-foreground opacity-100 shadow-sm'
            : 'bg-black/55 text-white opacity-0 hover:bg-black/75 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
        }`}
      >
        <StarIcon width={14} height={14} filled={pinned} aria-hidden />
      </button>

      {/*
        遮罩写死成黑色而不是用主题背景色：缩略图明暗不受我们控制，浅色图上跟着主题走的
        半透明背景会淡到没有，白字就糊在图里。文字同理固定白色，两种主题下都压在黑罩上。
      */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/65 to-transparent px-3 pb-3 pt-10">
        <div className="truncate text-[13px] font-medium text-white">{item.title}</div>
        <div className="truncate text-[11px] text-white/70">{item.category}</div>
      </div>
    </div>
  )
}
