import type { KeyboardEvent, MouseEvent } from 'react'
import { useStore } from '../../../store'
import { StarIcon } from '../../../components/icons'
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
      title={`${item.title}\n推荐模型：${item.recommendedModel}`}
      className="group relative flex w-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-gray-50/40 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-400/60 dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-blue-500/40 dark:hover:shadow-blue-500/10"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-gray-200 dark:bg-white/[0.05]">
        <img
          src={item.thumbnailUrl}
          alt={item.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
        />

        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white backdrop-blur-sm">
          {item.category}
        </span>

        <button
          type="button"
          onClick={handlePinClick}
          aria-pressed={pinned}
          aria-label={pinned ? '取消置顶' : '置顶'}
          className={`absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
            pinned
              ? 'bg-amber-400/90 text-white opacity-100 shadow-sm'
              : 'bg-black/45 text-white opacity-0 hover:bg-black/65 group-hover:opacity-100'
          }`}
        >
          <StarIcon width={14} height={14} filled={pinned} aria-hidden />
        </button>

        <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/85 via-black/45 to-transparent opacity-0 transition duration-300 group-hover:opacity-100">
          <p className="line-clamp-6 p-3 text-[11px] leading-relaxed text-white/95">
            {item.prompt}
          </p>
        </div>
      </div>

      <div className="px-3 py-2.5">
        <div className="line-clamp-2 text-sm font-medium leading-snug text-gray-800 transition group-hover:text-blue-600 dark:text-gray-100 dark:group-hover:text-blue-300">
          {item.title}
        </div>
      </div>
    </div>
  )
}
