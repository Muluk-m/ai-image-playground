// Presentation adapted from assistant-ui Elements image-gallery (MIT), 2026-10-09.
import type { ReactNode } from 'react'

interface GalleryItem {
  readonly id: string
  readonly source: string | null
}

export function ImageGallery<T extends GalleryItem>({
  items,
  itemLabel,
  renderItem,
  onSelect,
  selectedId,
}: {
  items: readonly T[]
  itemLabel: (index: number) => string
  renderItem: (item: T, index: number) => ReactNode
  onSelect: (item: T) => void
  selectedId?: string
}) {
  if (!items.length) return null
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  )
  return (
    <div
      data-slot="image-gallery"
      className="studio-agent-inline-gallery"
      data-count={items.length}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const next = Math.max(
          0,
          Math.min(items.length - 1, selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1)),
        )
        onSelect(items[next])
        event.currentTarget.children[next]
          ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
          ?.focus()
      }}
    >
      {items.map((item, index) => (
        <div
          key={item.id}
          role="group"
          aria-label={itemLabel(index)}
          data-selected={index === selectedIndex || undefined}
          className="min-w-0 max-w-full shrink-0"
          onFocus={() => onSelect(item)}
          onClickCapture={() => onSelect(item)}
        >
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  )
}
