import type { MouseEvent } from 'react'
import { useStore } from '../../../store'
import type { InspirationItem } from '../types'

interface Props {
  item: InspirationItem
  onClick: () => void
}

export default function InspirationCard({ item, onClick }: Props) {
  const pinned = useStore((s) => s.pinnedInspirationIds.includes(item.id))
  const togglePin = useStore((s) => s.toggleInspirationPin)

  const handlePinClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    togglePin(item.id)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${item.title}\n推荐模型：${item.recommendedModel}`}
      className="group relative flex w-full flex-col overflow-hidden rounded-2xl border border-gray-200/60 bg-gray-50/40 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-blue-500/40 dark:hover:shadow-blue-500/10"
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-gray-200 dark:bg-white/[0.05]">
        <img
          src={item.thumbnailUrl}
          alt={item.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
        />

        {/* 顶部分类徽章 */}
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white backdrop-blur-sm">
          {item.category}
        </span>

        {/* 置顶按钮：未 pin 时 hover 才显示；已 pin 时常驻 + 暖色高亮。 */}
        <button
          type="button"
          onClick={handlePinClick}
          aria-pressed={pinned}
          aria-label={pinned ? '取消置顶' : '置顶'}
          className={`absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
            pinned
              ? 'bg-amber-400/90 text-white shadow-sm opacity-100'
              : 'bg-black/45 text-white opacity-0 group-hover:opacity-100 hover:bg-black/65'
          }`}
        >
          <PinIcon filled={pinned} />
        </button>

        {/* hover 时显示 prompt 预览 */}
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
    </button>
  )
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}
