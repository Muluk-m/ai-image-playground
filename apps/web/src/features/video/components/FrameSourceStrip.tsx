import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { GHOST_BUTTON, LABEL } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { mergeFrameSources } from '../lib/frameSources'
import { useVideoStore } from '../store'

const LIMIT = 8

export default function FrameSourceStrip({
  selectedImageId,
  showLastFrame,
  onPickAll,
}: {
  selectedImageId: string | null
  showLastFrame: boolean
  onPickAll: () => void
}) {
  const assets = useLibraryStore(useShallow((s) => s.assets))
  const tasks = useStore(useShallow((s) => s.tasks))
  const sources = useMemo(() => mergeFrameSources(assets, tasks, LIMIT), [assets, tasks])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 min-w-0">
      <div className="mb-1 flex items-baseline justify-between">
        <span className={LABEL}>素材库 · 最近出图</span>
        <button type="button" className={GHOST_BUTTON} onClick={onPickAll}>
          全部…
        </button>
      </div>
      <ul className="hide-scrollbar flex gap-2 overflow-x-auto pb-1">
        {sources.map((source) => (
          <li key={source.imageId} className="group relative shrink-0">
            <button
              type="button"
              onClick={() => useVideoStore.getState().setFrame('first', source.imageId)}
              title={source.name || '填入首帧'}
              className={`block h-[62px] w-[62px] overflow-hidden rounded-lg border transition ${
                source.imageId === selectedImageId
                  ? 'border-blue-400 ring-2 ring-blue-400/50'
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
