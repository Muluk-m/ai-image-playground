import { useLibraryStore } from '../store'
import NamingDialog from './NamingDialog'

export default function SaveTemplateDialog() {
  const open = useLibraryStore((s) => s.namingTemplate)
  const cancelNamingTemplate = useLibraryStore((s) => s.cancelNamingTemplate)
  const saveTemplate = useLibraryStore((s) => s.saveTemplate)

  if (!open) return null

  return (
    <NamingDialog
      title="存为模板"
      description="保存当前提示词、引用的素材与尺寸 / 质量 / 数量"
      placeholder="模板名"
      onCancel={cancelNamingTemplate}
      onSave={(name) => void saveTemplate(name)}
    />
  )
}
