import { useRef, useState } from 'react'
import Badge from '../../../components/patterns/Badge'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draftDescription, setDescription] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const description = draftDescription ?? asset.description ?? ''
  const [saving, setSaving] = useState(false)
  const writing = useRef(false)
  const saveDescription = async () => {
    if (writing.current) return
    const latest = useLibraryStore.getState().assets.find((one) => one.id === asset.id)
    if (!latest) return
    writing.current = true
    setSaving(true)
    try {
      await saveAssetRecord({ ...latest, description: description.trim() })
      setDescription(null)
      setEditing(false)
    } catch {
      useStore.getState().showToast(t('asset.saveFailed'), 'error')
    } finally {
      writing.current = false
      setSaving(false)
    }
  }

  /** 选进来的图追加成新视角；一次超过阈值先问一声，确认了才存图写库。 */
  const addViews = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    confirmImageBatch(images.length, () => void appendViews(images))
  }

  const appendViews = async (images: File[]) => {
    if (writing.current) return
    writing.current = true
    setSaving(true)
    try {
      const stored = await Promise.all(
        images.map((file) => storeImageFromFile(file, { compress: true })),
      )
      const latest = useLibraryStore.getState().assets.find((one) => one.id === asset.id)
      if (!latest) return
      await saveAssetRecord({
        ...latest,
        views: [
          ...latest.views,
          ...stored.map((image) => ({
            imageId: image.id,
            label: 'none' as const,
            source: 'upload' as const,
          })),
        ],
      })
    } catch {
      useStore.getState().showToast(t('asset.saveFailed'), 'error')
    } finally {
      writing.current = false
      setSaving(false)
    }
  }

  return (
    <Overlay onClose={onClose} tier="raised" layout="fill" backdrop="none" label={asset.name}>
      <div className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col overflow-hidden border-l border-border bg-card shadow-dialog">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
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
            autoTooltip={false}
            onClick={onClose}
            aria-label={t('common:action.close')}
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {assetCoverImageId(asset) && (
            <div className="relative mb-4 aspect-square overflow-hidden rounded-xl bg-muted">
              <AssetThumb imageId={assetCoverImageId(asset)} alt={asset.name} />
            </div>
          )}
          {editing ? (
            <form
              className="mb-5 space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                void saveDescription()
              }}
            >
              <label className="block text-sm">
                {t('createAsset.description')}
                <Textarea
                  ref={textareaRef}
                  className="mt-2"
                  value={description}
                  disabled={saving}
                  rows={3}
                  maxLength={20000}
                  placeholder={t('createAsset.descriptionPlaceholder')}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={saving || description === (asset.description ?? '')}
                >
                  {t('common:action.save')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setDescription(null)
                    setEditing(false)
                  }}
                >
                  {t('common:action.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="mb-5">
              <h4 className="text-sm font-medium text-foreground">
                {t('createAsset.description')}
              </h4>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          )}
          <ul className="grid grid-cols-3 gap-2">
            {asset.views.map((view, index) => (
              <li key={view.imageId} className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  autoTooltip={false}
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
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square h-auto w-full flex-col gap-1 whitespace-normal rounded-xl border-dashed border-border text-xs font-normal text-muted-foreground hover:border-primary hover:bg-transparent hover:text-foreground"
              >
                <Icon name="add" size="md" />
                {t('asset.addView')}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                disabled={saving}
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
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-4 [&>button]:flex-1">
          {!editing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('common:action.edit')}
              onClick={() => {
                setEditing(true)
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            >
              {t('common:action.edit')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={saving || asset.views.length === 0}
            onClick={() => {
              void attachAsset(asset.id)
              onClose()
            }}
          >
            {t('asset.addAsReference')}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
