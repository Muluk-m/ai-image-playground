import { useRef } from 'react'
import Badge from '../../../components/patterns/Badge'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
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
      <div className="relative z-10 flex max-h-[85vh] w-[min(94vw,760px)] flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl ring-1 ring-hairline animate-modal-in">
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void attachAsset(asset.id)
              onClose()
            }}
            className="h-auto bg-primary/10 px-2.5 py-1 text-label-sm font-medium text-primary hover:bg-primary/20 hover:text-primary"
          >
            {t('asset.addAsReference')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t('common:action.close')}
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon name="close" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {asset.views.map((view, index) => (
              <li key={view.imageId} className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setLightboxImageId(view.imageId)}
                  aria-label={t('asset.zoom')}
                  className="group relative aspect-square h-auto w-full overflow-hidden rounded-xl border border-border bg-muted p-0 hover:bg-muted"
                >
                  <AssetThumb imageId={view.imageId} alt={asset.name} />
                  {view.imageId === assetCoverImageId(asset) && index === 0 && (
                    <Badge tone="overlay" className="pointer-events-none absolute left-1.5 top-1.5">
                      {t('asset.cover')}
                    </Badge>
                  )}
                </Button>
                <span className="flex items-center justify-between text-label-sm text-muted-foreground">
                  <span>{t(`asset.view.${view.label}`)}</span>
                  <span>{t(`asset.source.${view.source}`)}</span>
                </span>
              </li>
            ))}
            <li>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square h-auto w-full flex-col gap-1 whitespace-normal rounded-xl border-dashed border-border text-xs font-normal text-muted-foreground hover:border-primary hover:bg-transparent hover:text-foreground"
              >
                <Icon name="add" size="md" />
                {t('asset.addView')}
              </Button>
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
