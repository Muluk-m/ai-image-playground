// Presentation adapted from assistant-ui Elements image-gallery (MIT), 2026-10-09.
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '../../ui/button'

interface GalleryItem {
  readonly id: string
  readonly source: string | null
}

export function ImageGallery<T extends GalleryItem>({
  items,
  previousLabel,
  nextLabel,
  itemLabel,
  renderItem,
  onSelect,
}: {
  items: readonly T[]
  previousLabel: string
  nextLabel: string
  itemLabel: (index: number) => string
  renderItem: (item: T, index: number) => ReactNode
  onSelect?: (item: T) => void
}) {
  const [selectedId, setSelectedId] = useState<string>()
  if (!items.length) return null
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  )
  const select = (next: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, next))]
    setSelectedId(item.id)
    onSelect?.(item)
  }
  return (
    <div
      data-slot="image-gallery"
      className="flex w-full min-w-0 flex-col gap-2"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        select(index + (event.key === 'ArrowLeft' ? -1 : 1))
      }}
    >
      <div className="relative w-full min-w-0">
        {renderItem(items[index], index)}
        {items.length > 1 && (
          <>
            <span
              aria-live="polite"
              className="absolute right-2 top-2 rounded-md bg-background/90 px-2 py-1 text-xs tabular-nums text-foreground"
            >
              {index + 1} / {items.length}
            </span>
            {[
              {
                label: previousLabel,
                icon: ChevronLeft,
                offset: -1,
                position: 'left-2',
                disabled: index === 0,
              },
              {
                label: nextLabel,
                icon: ChevronRight,
                offset: 1,
                position: 'right-2',
                disabled: index === items.length - 1,
              },
            ].map(({ label, icon: Icon, offset, position, disabled }) => (
              <Button
                key={offset}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={label}
                title={label}
                className={`absolute top-1/2 size-8 -translate-y-1/2 bg-background/90 text-foreground hover:bg-background focus-visible:ring-foreground ${position}`}
                disabled={disabled}
                onClick={() => select(index + offset)}
              >
                <Icon aria-hidden className="size-4" />
              </Button>
            ))}
          </>
        )}
      </div>
      {items.length > 1 && (
        <div className="flex max-w-full flex-wrap gap-1.5">
          {items.map((item, itemIndex) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              aria-label={itemLabel(itemIndex)}
              aria-pressed={itemIndex === index}
              title={itemLabel(itemIndex)}
              className={`h-12 w-14 overflow-hidden rounded-lg border p-0.5 hover:bg-foreground/5 focus-visible:ring-foreground ${itemIndex === index ? 'border-foreground' : 'border-border'}`}
              onClick={() => select(itemIndex)}
            >
              {item.source ? (
                <img
                  src={item.source}
                  alt=""
                  className="h-full w-full rounded-md object-contain"
                  loading="lazy"
                />
              ) : (
                <span className="text-xs">{itemIndex + 1}</span>
              )}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
