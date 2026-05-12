import type { InspirationItemWithSource } from '../types'

interface Props {
  item: InspirationItemWithSource
  onClick: () => void
}

export default function InspirationCard({ item, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-gray-200/60 bg-gray-50/40 text-left transition hover:border-blue-300 hover:shadow-lg dark:border-white/[0.06] dark:bg-white/[0.02] dark:hover:border-blue-500/40"
    >
      <div className="aspect-[3/4] overflow-hidden bg-gray-200 dark:bg-white/[0.05]">
        <img
          src={item.thumbnailUrl}
          alt={item.title}
          loading="lazy"
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
        />
      </div>
      {item.source === 'remote' && (
        <span className="absolute right-2 top-2 rounded-full bg-blue-500/90 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm backdrop-blur">
          远程
        </span>
      )}
      <div className="p-3">
        <div className="line-clamp-1 text-sm font-medium text-gray-800 dark:text-gray-100">
          {item.title}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="rounded-md bg-gray-100 px-1.5 py-0.5 dark:bg-white/[0.06]">
            {item.category}
          </span>
          <span className="truncate">{item.recommendedModel}</span>
        </div>
      </div>
    </button>
  )
}
