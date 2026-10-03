import { FileText, ImagePlus, SearchX } from 'lucide-react'
import EmptyState from '../../../components/EmptyState'
import { useTranslation } from '../../../i18n'
import NewAssetButton from './NewAssetButton'

export function AssetsEmpty({ onImport }: { onImport: () => void }) {
  const { t } = useTranslation('library')

  return (
    <EmptyState
      icon={<ImagePlus />}
      title={t('empty.assetsTitle')}
      // 「长按」只在触屏上成立，精确指针下不显示。
      description={<span className="[@media(pointer:fine)]:hidden">{t('empty.assetsMobile')}</span>}
      action={<NewAssetButton onClick={onImport} />}
    />
  )
}

export function TemplatesEmpty() {
  const { t } = useTranslation('library')

  return <EmptyState icon={<FileText />} title={t('empty.templates')} />
}

/** 库里有东西、只是被搜索过滤光时的那一行。 */
export function NoMatch({ label }: { label: string }) {
  return <EmptyState icon={<SearchX />} title={label} />
}
