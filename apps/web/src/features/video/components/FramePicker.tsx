import { useMemo, useState } from 'react'
import Overlay from '../../../components/Overlay'
import { PANEL_TITLE } from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { assetSources, historySources } from '../lib/frameSources'

const TABS = ['library', 'history'] as const
type PickerTab = (typeof TABS)[number]

export default function FramePicker({
  label,
  selectedImageIds,
  onSelect,
  onClose,
}: {
  label: string
  /** 给了就是多选：选中的图带上高亮环，关不关由调用方决定。 */
  selectedImageIds?: readonly string[]
  onSelect: (imageId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('video')
  const tabLabels: Record<PickerTab, string> = {
    library: t('picker.tabLibrary'),
    history: t('picker.tabHistory'),
  }
  const [tab, setTab] = useState<PickerTab>('library')
  const assets = useLibraryStore((s) => s.assets)
  const tasks = useStore((s) => s.tasks)
  const items = useMemo(
    () => (tab === 'library' ? assetSources(assets) : historySources(tasks)),
    [tab, assets, tasks],
  )

  return (
    <Overlay onClose={onClose}>
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-white/50 bg-card p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in border-border dark:ring-white/10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className={PANEL_TITLE}>{t('picker.title', { label })}</h3>
          <Segmented
            label={t('picker.sourceLabel')}
            options={TABS}
            labels={tabLabels}
            value={tab}
            onChange={setTab}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tab === 'library' ? t('picker.emptyLibrary') : t('picker.emptyHistory')}
            </p>
          ) : (
            <ul className="grid grid-cols-3 gap-3">
              {items.map((item) => (
                <li key={`${tab}-${item.imageId}`}>
                  <button
                    type="button"
                    aria-pressed={
                      selectedImageIds ? selectedImageIds.includes(item.imageId) : undefined
                    }
                    onClick={() => onSelect(item.imageId)}
                    className={`w-full overflow-hidden rounded-xl border transition ${
                      selectedImageIds?.includes(item.imageId)
                        ? 'border-primary ring-2 ring-ring/30'
                        : 'border-border hover:border-primary'
                    }`}
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
