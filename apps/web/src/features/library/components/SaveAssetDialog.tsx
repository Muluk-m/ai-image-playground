import { useLibraryStore } from '../store'
import AssetThumb from './AssetThumb'
import NamingDialog from './NamingDialog'

export default function SaveAssetDialog() {
  const pending = useLibraryStore((s) => s.pendingAssetNames[0] ?? null)
  const remaining = useLibraryStore((s) => s.pendingAssetNames.length)
  const cancelNaming = useLibraryStore((s) => s.cancelNaming)
  const saveAsset = useLibraryStore((s) => s.saveAsset)

  if (!pending) return null

  return (
    <NamingDialog
      key={`${pending.imageId}:${remaining}`}
      title="存为素材"
      description={remaining > 1 ? `还剩 ${remaining} 张` : undefined}
      placeholder="素材名"
      defaultName={pending.defaultName}
      preview={<AssetThumb imageId={pending.imageId} alt="" />}
      onCancel={cancelNaming}
      onSave={(name) => void saveAsset(pending.imageId, name)}
    />
  )
}
