import { useMemo, useState } from 'react'
import Overlay from '../../../components/Overlay'
import { PANEL_TITLE } from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { assetSources, historySources } from '../lib/frameSources'
import { useVideoStore } from '../store'
import { VIDEO_FRAME_SLOT_LABELS, type VideoFrameSlot } from '../types'

const TABS = ['library', 'history'] as const
type PickerTab = (typeof TABS)[number]
const TAB_LABELS: Record<PickerTab, string> = { library: '素材库', history: '工作台历史' }

const EMPTY: Record<PickerTab, string> = {
  library: '素材库还是空的',
  history: '工作台还没有出过图',
}

export default function FramePicker({
  slot,
  label,
  onClose,
}: {
  slot: VideoFrameSlot
  label?: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<PickerTab>('library')
  const assets = useLibraryStore((s) => s.assets)
  const tasks = useStore((s) => s.tasks)
  const items = useMemo(
    () => (tab === 'library' ? assetSources(assets) : historySources(tasks)),
    [tab, assets, tasks],
  )

  return (
    <Overlay onClose={onClose}>
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className={PANEL_TITLE}>选{label ?? VIDEO_FRAME_SLOT_LABELS[slot]}</h3>
          <Segmented
            label="图片来源"
            options={TABS}
            labels={TAB_LABELS}
            value={tab}
            onChange={setTab}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{EMPTY[tab]}</p>
          ) : (
            <ul className="grid grid-cols-3 gap-3">
              {items.map((item) => (
                <li key={`${tab}-${item.imageId}`}>
                  <button
                    type="button"
                    onClick={() => {
                      useVideoStore.getState().setFrame(slot, item.imageId)
                      onClose()
                    }}
                    className="w-full overflow-hidden rounded-xl border border-gray-200 transition hover:border-blue-400 dark:border-white/[0.08]"
                  >
                    <span className="block aspect-square">
                      <AssetThumb imageId={item.imageId} alt={item.name} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Overlay>
  )
}
