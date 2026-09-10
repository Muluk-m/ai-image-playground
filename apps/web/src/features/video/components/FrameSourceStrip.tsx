import { useMemo } from 'react'
import { GHOST_BUTTON, LABEL } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { stripSources } from '../lib/frameSources'
import { useVideoStore } from '../store'

const CAPTION = '素材库 · 最近出图'

export default function FrameSourceStrip({
  showLastFrame,
  fillLabel = '填入首帧',
  selectedImageIds,
  onSelect,
  onPickAll,
}: {
  showLastFrame: boolean
  fillLabel?: string
  selectedImageIds: readonly string[]
  onSelect: (imageId: string) => void
  onPickAll: () => void
}) {
  const assets = useLibraryStore((s) => s.assets)
  const tasks = useStore((s) => s.tasks)
  const sources = useMemo(() => stripSources(assets, tasks), [assets, tasks])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 min-w-0">
      <div className="mb-1 flex items-baseline justify-between">
        <span className={LABEL}>{CAPTION}</span>
        <button type="button" className={GHOST_BUTTON} onClick={onPickAll}>
          全部…
        </button>
      </div>
      <ul aria-label={CAPTION} className="hide-scrollbar flex gap-2 overflow-x-auto pb-1">
        {sources.map((source) => (
          <li key={source.imageId} className="group relative shrink-0">
            <button
              type="button"
              aria-pressed={selectedImageIds.includes(source.imageId)}
              onClick={() => onSelect(source.imageId)}
              title={source.name || fillLabel}
              className={`block h-[62px] w-[62px] overflow-hidden rounded-lg border transition ${
                selectedImageIds.includes(source.imageId)
                  ? 'border-blue-400 ring-2 ring-blue-400/30'
                  : 'border-gray-200 hover:border-blue-300 dark:border-white/[0.08]'
              }`}
            >
              <AssetThumb imageId={source.imageId} alt={source.name} />
              {source.name && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate rounded-b-lg bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2 text-left text-[10px] text-white">
                  {source.name}
                </span>
              )}
            </button>
            {showLastFrame && (
              <button
                type="button"
                onClick={() => useVideoStore.getState().setFrame('last', source.imageId)}
                className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 px-1 text-[10px] text-white group-hover:block"
              >
                尾帧
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
