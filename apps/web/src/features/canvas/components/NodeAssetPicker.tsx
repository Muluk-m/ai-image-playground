import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../components/ui/sheet'
import { useTranslation } from '../../../i18n'
import AssetThumb from '../../library/components/AssetThumb'
import CreateRecordDialog from '../../library/components/CreateRecordDialog'
import { useLibraryStore } from '../../library/store'
import { type AssetRecord, assetCoverImageId } from '../../library/types'
import { ASSET_DRAG_TYPE } from '../lib/nodeAssets'

export default function NodeAssetPicker({
  onClose,
  onChoose,
}: {
  onClose: () => void
  onChoose: (asset: AssetRecord, imageId?: string) => void
}) {
  const { t } = useTranslation('canvas')
  const { t: common } = useTranslation('common')
  const { t: library } = useTranslation('library')
  const assets = useLibraryStore((s) => s.assets)
  const [query, setQuery] = useState('')
  const [failed, setFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    void useLibraryStore
      .getState()
      .loadAssets()
      .catch(() => setFailed(true))
  }, [])
  const visible = assets.filter((asset) =>
    `${asset.name} ${asset.description ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <>
      <Sheet
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open && !creating) onClose()
        }}
      >
        <SheetContent
          className="flex w-[min(92vw,380px)] flex-col p-5"
          closeLabel={common('action.close')}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <SheetTitle>{t('nodes.assets')}</SheetTitle>
          <SheetDescription>{t('nodes.assetDragHint')}</SheetDescription>
          <div className="flex gap-2">
            <Input
              aria-label={t('nodes.assets')}
              placeholder={t('nodes.assets')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label={library('createAsset.title')}
              onClick={() => setCreating(true)}
            >
              <Icon name="add" />
            </Button>
          </div>
          {!visible.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t(failed ? 'import.failed' : 'nodes.assetsEmpty')}
            </p>
          )}
          <div className="grid min-h-0 grid-cols-2 gap-3 overflow-auto">
            {visible.map((asset) => (
              <div key={asset.id} className="min-w-0 rounded-xl border bg-card p-2">
                <Button
                  variant="ghost"
                  className="h-auto w-full flex-col items-stretch p-0 text-left"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => onChoose(asset)}
                >
                  <div className="aspect-square overflow-hidden rounded-lg">
                    <AssetThumb imageId={assetCoverImageId(asset)} alt={asset.name} />
                  </div>
                  <span className="truncate text-xs">{asset.name}</span>
                </Button>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {asset.description ||
                    (asset.views.length
                      ? asset.kind
                        ? library(`asset.kind.${asset.kind}`)
                        : ''
                      : library('asset.noImage'))}
                </p>
                {asset.views.length > 1 && (
                  <div className="mt-2 flex gap-1 overflow-x-auto">
                    {asset.views.map((view) => (
                      <Button
                        key={view.imageId}
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 overflow-hidden p-0"
                        aria-label={`${asset.name} · ${library(`asset.view.${view.label}`)}`}
                        onClick={() => onChoose(asset, view.imageId)}
                      >
                        <AssetThumb imageId={view.imageId} alt="" />
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
      {creating && (
        <CreateRecordDialog
          kind="asset"
          agentReady={false}
          onClose={() => setCreating(false)}
          onSave={({ files, name, kind, description }) =>
            useLibraryStore
              .getState()
              .importAssetFiles(files, { group: true, name, kind, description })
          }
        />
      )}
    </>
  )
}
