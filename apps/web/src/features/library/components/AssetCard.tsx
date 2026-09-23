import { type KeyboardEvent, useMemo, useState } from 'react'
import Badge from '../../../components/Badge'
import { EditIcon, LayersIcon, TrashIcon, VideoIcon, ZoomIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { useSyncStatus } from '../../../lib/sync/status'
import { useStore } from '../../../store'
import { startVideoFromImage } from '../../canvas/lib/startVideoFromImage'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { assetCoverImageId } from '../types'
import AssetThumb from './AssetThumb'

const ICON_BUTTON =
  'shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-muted-foreground'

export default function AssetCard({
  asset,
  onOpen,
}: {
  asset: AssetRecord
  onOpen: (asset: AssetRecord) => void
}) {
  const { t } = useTranslation(['library', 'common'])
  const attachAsset = useLibraryStore((s) => s.attachAsset)
  const renameAsset = useLibraryStore((s) => s.renameAsset)
  const deleteAsset = useLibraryStore((s) => s.deleteAsset)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const videoAvailable = useMemo(() => isVideoModeAvailable(), [])
  const coverImageId = assetCoverImageId(asset)
  const unsynced = useSyncStatus(
    (s) => s.enabled && asset.views.some((view) => s.unsyncedImages.includes(view.imageId)),
  )
  const [draftName, setDraftName] = useState<string | null>(null)

  const commitRename = () => {
    if (draftName !== null) void renameAsset(asset.id, draftName)
    setDraftName(null)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void attachAsset(asset.id)
    }
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary hover:shadow-lg">
      {/* 外层不是 <button>：卡片内还有放大、重命名与删除按钮，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => void attachAsset(asset.id)}
        onKeyDown={handleKeyDown}
        title={asset.name}
        className="relative aspect-square cursor-pointer overflow-hidden bg-muted focus:outline-none focus:ring-2 focus:ring-ring/60"
      >
        <AssetThumb imageId={coverImageId} alt={asset.name} />
        <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
          {asset.kind && <Badge tone="overlay">{t(`asset.kind.${asset.kind}`)}</Badge>}
          {unsynced && <Badge tone="overlay">{t('asset.unsynced')}</Badge>}
        </div>
        {/* 标签常显：触屏没有 hover，只在 hover 时才现就等于没有。 */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4 text-[11px] font-medium text-white">
          <span>{t('asset.addAsReference')}</span>
          {asset.background && (
            <Badge tone={asset.background === 'transparent' ? 'success' : 'overlay'}>
              {t(`asset.background.${asset.background}`)}
            </Badge>
          )}
        </span>
      </div>

      <div className="absolute right-1.5 top-1.5 flex gap-1">
        {asset.views.length > 1 && (
          <button
            type="button"
            onClick={() => onOpen(asset)}
            aria-label={t('asset.views')}
            title={t('asset.views')}
            className="inline-flex items-center gap-0.5 rounded-lg bg-black/45 px-1.5 py-1 text-[10px] font-medium text-white transition hover:bg-black/65"
          >
            <LayersIcon className="h-3 w-3" />
            {t('asset.viewCount', { count: asset.views.length })}
          </button>
        )}
        <button
          type="button"
          onClick={() => setLightboxImageId(coverImageId)}
          aria-label={t('asset.zoom')}
          title={t('asset.zoom')}
          className="rounded-lg bg-black/45 p-1.5 text-white transition hover:bg-black/65"
        >
          <ZoomIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1 px-2.5 py-2">
        {draftName === null ? (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {asset.name}
          </span>
        ) : (
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setDraftName(null)
            }}
            maxLength={40}
            className="min-w-0 flex-1 rounded-md border border-primary bg-card px-1.5 py-0.5 text-xs text-foreground focus:outline-none"
          />
        )}

        {videoAvailable && (
          <button
            type="button"
            onClick={() => void startVideoFromImage(coverImageId)}
            aria-label={t('asset.makeVideo')}
            title={t('asset.makeVideo')}
            className={ICON_BUTTON}
          >
            <VideoIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onOpen(asset)}
          aria-label={t('asset.views')}
          className={ICON_BUTTON}
        >
          <LayersIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setDraftName(asset.name)}
          aria-label={t('action.rename')}
          className={ICON_BUTTON}
        >
          <EditIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() =>
            setConfirmDialog({
              title: t('asset.deleteTitle'),
              message: t('asset.deleteMessage', { name: asset.name }),
              action: () => void deleteAsset(asset.id),
            })
          }
          aria-label={t('common:action.delete')}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/10"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
