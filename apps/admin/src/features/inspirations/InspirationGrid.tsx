import type { InspirationAdminItem, InspirationCategory } from '@image-playground/shared'
import { ImageOff, Star } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { assetUrl, KIND_LABEL, STATUS_BADGE, STATUS_LABEL } from './constants'

interface InspirationGridProps {
  items: InspirationAdminItem[]
  categories: InspirationCategory[]
  selectedId?: string
  onSelect: (id: string) => void
}

export function InspirationGrid({ items, categories, selectedId, onSelect }: InspirationGridProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {items.map((item) => {
        const cover = assetUrl(item.coverKey)
        const category = categories.find((entry) => entry.id === item.categoryId)
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={item.id === selectedId}
            className="group overflow-hidden rounded-xl border bg-card text-left transition hover:-translate-y-0.5 hover:shadow-md aria-[current=true]:border-primary aria-[current=true]:ring-1 aria-[current=true]:ring-primary"
          >
            <div className="relative aspect-[4/3] overflow-hidden bg-muted">
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
                />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
                  <ImageOff className="size-5" />
                  <span className="px-3 text-center text-[11px] leading-tight">
                    封面不是公开地址，无法预览
                  </span>
                </div>
              )}
              <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-2">
                <Badge variant="secondary" className="shadow-none backdrop-blur">
                  {KIND_LABEL[item.kind]}
                </Badge>
                {item.featured ? (
                  <span
                    title="首页推荐位"
                    className="rounded-full bg-primary p-1 text-primary-foreground"
                  >
                    <Star className="size-3 fill-current" />
                  </span>
                ) : null}
              </div>
            </div>
            <div className="space-y-2 p-3">
              <div className="flex items-start gap-2">
                <strong className="line-clamp-1 flex-1 text-sm">{item.title || item.id}</strong>
                <Badge variant={STATUS_BADGE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{category?.name ?? item.categoryId}</span>
                <span className="shrink-0 tabular-nums">排序 {item.sort}</span>
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
