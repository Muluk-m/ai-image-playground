import { useRef } from 'react'
import Badge from '../../../components/Badge'
import { CloseIcon, PlusIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { storeImageFromFile, useStore } from '../../../store'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { assetCoverImageId } from '../types'
import AssetThumb from './AssetThumb'

export default function AssetDetail({
  asset,
  onClose,
}: {
  asset: AssetRecord
  onClose: () => void
}) {
  const { t } = useTranslation(['library', 'common'])
  const saveAssetRecord = useLibraryStore((s) => s.saveAssetRecord)
  const attachAsset = useLibraryStore((s) => s.attachAsset)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 选进来的图追加成新视角；一次超过阈值先问一声，确认了才存图写库。 */
  const addViews = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    confirmImageBatch(images.length, () => void appendViews(images))
  }

  const appendViews = async (images: File[]) => {
    const stored = await Promise.all(
      images.map((file) => storeImageFromFile(file, { compress: true })),
    )
    await saveAssetRecord({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      background: asset.background,
      views: [
        ...asset.views,
        ...stored.map((image) => ({
          imageId: image.id,
          label: 'none' as const,
          source: 'upload' as const,
        })),
      ],
    })
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative z-10 flex max-h-[85vh] w-[min(94vw,760px)] flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-4">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
            {asset.name}
          </h3>
          {asset.kind && <Badge tone="primary">{t(`asset.kind.${asset.kind}`)}</Badge>}
          {asset.background && (
            <Badge tone={asset.background === 'transparent' ? 'success' : 'neutral'}>
              {t(`asset.background.${asset.background}`)}
            </Badge>
          )}
          <button
            type="button"
            onClick={() => {
              void attachAsset(asset.id)
              onClose()
            }}
            className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20"
          >
            {t('asset.addAsReference')}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:action.close')}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {asset.views.map((view, index) => (
              <li key={view.imageId} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setLightboxImageId(view.imageId)}
                  aria-label={t('asset.zoom')}
                  className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted focus:outline-none focus:ring-2 focus:ring-ring/60"
                >
                  <AssetThumb imageId={view.imageId} alt={asset.name} />
                  {view.imageId === assetCoverImageId(asset) && index === 0 && (
                    <Badge tone="overlay" className="pointer-events-none absolute left-1.5 top-1.5">
                      {t('asset.cover')}
                    </Badge>
                  )}
                </button>
                <span className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{t(`asset.view.${view.label}`)}</span>
                  <span>{t(`asset.source.${view.source}`)}</span>
                </span>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-xs text-muted-foreground transition hover:border-primary hover:text-foreground"
              >
                <PlusIcon className="h-5 w-5" />
                {t('asset.addView')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addViews([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </li>
          </ul>
        </div>
      </div>
    </Overlay>
  )
}
