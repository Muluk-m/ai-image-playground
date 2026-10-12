import { useEffect, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
export default function NodeAssetPicker({
  onClose,
  onChoose,
}: {
  onClose: () => void
  onChoose: (imageId: string, name: string) => void
}) {
  const { t } = useTranslation('canvas')
  const { t: common } = useTranslation('common')
  const assets = useLibraryStore((s) => s.assets)
  const [query, setQuery] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void useLibraryStore
      .getState()
      .loadAssets()
      .catch(() => setFailed(true))
  }, [])
  return (
    <Overlay onClose={onClose} label={t('nodes.assets')}>
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2>{t('nodes.assets')}</h2>
          <Button variant="ghost" aria-label={common('action.close')} onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        <Input
          aria-label={t('nodes.assets')}
          placeholder={t('nodes.assets')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!assets.some(
          (asset) => asset.name.toLowerCase().includes(query.toLowerCase()) && asset.views.length,
        ) && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t(failed ? 'import.failed' : 'nodes.assetsEmpty')}
          </p>
        )}
        <div className="grid max-h-[60vh] grid-cols-3 gap-3 overflow-auto">
          {assets
            .filter((asset) => asset.name.toLowerCase().includes(query.toLowerCase()))
            .flatMap((asset) =>
              asset.views.map((view) => (
                <Button
                  key={`${asset.id}:${view.imageId}`}
                  variant="ghost"
                  className="h-auto flex-col items-stretch p-2"
                  onClick={() => onChoose(view.imageId, asset.name)}
                >
                  <div className="aspect-square overflow-hidden rounded-lg">
                    <AssetThumb imageId={view.imageId} alt={asset.name} />
                  </div>
                  <span className="truncate text-xs">{asset.name}</span>
                </Button>
              )),
            )}
        </div>
      </div>
    </Overlay>
  )
}
