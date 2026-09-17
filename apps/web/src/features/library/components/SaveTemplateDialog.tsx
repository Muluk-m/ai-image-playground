import { useTranslation } from '../../../i18n'
import { useLibraryStore } from '../store'
import NamingDialog from './NamingDialog'

export default function SaveTemplateDialog() {
  const { t } = useTranslation('library')
  const open = useLibraryStore((s) => s.namingTemplate)
  const cancelNamingTemplate = useLibraryStore((s) => s.cancelNamingTemplate)
  const saveTemplate = useLibraryStore((s) => s.saveTemplate)

  if (!open) return null

  return (
    <NamingDialog
      title={t('saveTemplate.title')}
      description={t('saveTemplate.description')}
      placeholder={t('saveTemplate.placeholder')}
      onCancel={cancelNamingTemplate}
      onSave={(name) => void saveTemplate(name)}
    />
  )
}
