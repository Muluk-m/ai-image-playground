import { type KeyboardEvent, type MouseEvent, useState } from 'react'
import Badge from '../../../components/patterns/Badge'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { OverflowText } from '../../../components/ui/overflowTitle'
import { useTranslation } from '../../../i18n'
import { useSyncStatus } from '../../../lib/sync/status'
import { useStore } from '../../../store'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { assetCoverImageId } from '../types'
import AssetThumb from './AssetThumb'

function stopCardClick(event: MouseEvent) {
  event.stopPropagation()
}

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
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(asset)
    }
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary hover:shadow-lg">
      {/* 外层不是 <button>：卡片内还有编辑、删除与放大按钮，嵌套 button 是 invalid HTML。 */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(asset)}
        onKeyDown={handleKeyDown}
        className="group/cover relative aspect-square cursor-pointer overflow-hidden bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AssetThumb imageId={coverImageId} alt={asset.name} />
        <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
          {asset.kind && <Badge tone="overlay">{t(`asset.kind.${asset.kind}`)}</Badge>}
          {unsynced && <Badge tone="overlay">{t('asset.unsynced')}</Badge>}
        </div>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4 text-label-sm font-medium text-white">
          {asset.background && (
            <Badge tone={asset.background === 'transparent' ? 'success' : 'overlay'}>
              {t(`asset.background.${asset.background}`)}
            </Badge>
          )}
          {!asset.views.length && <span>{t('asset.noImage')}</span>}
        </span>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/cover:opacity-100 group-focus-within/cover:opacity-100">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            autoTooltip={false}
            onClick={(event) => {
              stopCardClick(event)
              onOpen(asset)
            }}
            className="h-7 gap-1.5 bg-white/15 px-2.5 text-xs text-white hover:bg-white/25 hover:text-white"
          >
            <Icon name="zoomIn" size="xs" />
            {t('asset.viewDetail')}
          </Button>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex translate-y-1 items-center justify-center gap-1 bg-black/55 px-1 py-2 opacity-0 transition-all group-hover/cover:translate-y-0 group-hover/cover:opacity-100 group-focus-within/cover:translate-y-0 group-focus-within/cover:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            autoTooltip={false}
            disabled={!asset.views.length}
            onClick={(event) => {
              stopCardClick(event)
              void attachAsset(asset.id)
            }}
            className="h-7 min-w-0 gap-1 px-1 text-xs text-primary hover:bg-primary/15 hover:text-primary"
          >
            <Icon name="add" size="xs" />
            {t('asset.addAsReference')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            autoTooltip={false}
            onClick={(event) => {
              stopCardClick(event)
              setDraftName(asset.name)
            }}
            aria-label={t('common:action.edit')}
            className="text-white hover:bg-white/15 hover:text-white"
          >
            <Icon name="edit" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            autoTooltip={false}
            onClick={(event) => {
              stopCardClick(event)
              setConfirmDialog({
                title: t('asset.deleteTitle'),
                message: t('asset.deleteMessage', { name: asset.name }),
                action: () => void deleteAsset(asset.id),
              })
            }}
            aria-label={t('common:action.delete')}
            className="text-white hover:bg-destructive/20 hover:text-destructive"
          >
            <Icon name="delete" />
          </Button>
        </div>
      </div>

      <div className="absolute right-1.5 top-1.5 flex gap-1">
        {asset.views.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            autoTooltip={false}
            onClick={() => onOpen(asset)}
            aria-label={t('asset.views')}
            className="h-auto gap-0.5 rounded-lg bg-black/45 px-1.5 py-1 text-label-sm font-medium text-white hover:bg-black/65 hover:text-white"
          >
            <Icon name="layers" size="xs" />
            {t('asset.viewCount', { count: asset.views.length })}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          autoTooltip={false}
          disabled={!coverImageId}
          onClick={() => setLightboxImageId(coverImageId)}
          aria-label={t('asset.zoom')}
          className="rounded-lg bg-black/45 text-white hover:bg-black/65 hover:text-white"
        >
          <Icon name="zoomIn" />
        </Button>
      </div>

      <div className="flex items-center gap-1 px-2.5 py-2">
        {draftName === null ? (
          <OverflowText
            text={asset.name}
            className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
          />
        ) : (
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setDraftName(null)
            }}
            maxLength={40}
            className="h-7 min-w-0 flex-1 border-primary bg-card px-1.5 py-0.5 text-xs"
          />
        )}
      </div>
    </div>
  )
}
