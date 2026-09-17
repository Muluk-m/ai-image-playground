import { useTranslation } from '../../../i18n'
import { useLibraryStore } from '../store'
import AssetThumb from './AssetThumb'
import NamingDialog from './NamingDialog'

export default function SaveAssetDialog() {
  const { t } = useTranslation('library')
  const pending = useLibraryStore((s) => s.pendingAssetNames[0] ?? null)
  const remaining = useLibraryStore((s) => s.pendingAssetNames.length)
  const cancelNaming = useLibraryStore((s) => s.cancelNaming)
  const saveAsset = useLibraryStore((s) => s.saveAsset)

  if (!pending) return null

  return (
    <NamingDialog
      key={`${pending.imageId}:${remaining}`}
      title={t('saveAsset.title')}
      description={remaining > 1 ? t('saveAsset.remaining', { count: remaining }) : undefined}
      placeholder={t('saveAsset.placeholder')}
      defaultName={pending.defaultName}
      preview={<AssetThumb imageId={pending.imageId} alt="" />}
      onCancel={cancelNaming}
      onSave={(name) => void saveAsset(pending.imageId, name)}
    />
  )
}
