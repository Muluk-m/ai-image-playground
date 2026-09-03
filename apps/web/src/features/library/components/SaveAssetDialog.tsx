import { useLibraryStore } from '../store'
import AssetThumb from './AssetThumb'
import NamingDialog from './NamingDialog'

export default function SaveAssetDialog() {
  const imageId = useLibraryStore((s) => s.namingImageId)
  const cancelNaming = useLibraryStore((s) => s.cancelNaming)
  const saveAsset = useLibraryStore((s) => s.saveAsset)

  if (!imageId) return null

  return (
    <NamingDialog
      key={imageId}
      title="存为素材"
      placeholder="素材名"
      preview={<AssetThumb imageId={imageId} alt="" />}
      onCancel={cancelNaming}
      onSave={(name) => void saveAsset(imageId, name)}
    />
  )
}
