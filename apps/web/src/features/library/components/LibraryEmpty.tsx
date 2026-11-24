import EmptyState from '../../../components/patterns/EmptyState'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

export function AssetsEmpty() {
  const { t } = useTranslation('library')
  const isTouch =
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)

  return (
    <EmptyState
      icon={<Icon name="imageAdd" size="lg" />}
      title={t(isTouch ? 'empty.assetsMobile' : 'empty.assetsTitle')}
    />
  )
}

export function TemplatesEmpty() {
  const { t } = useTranslation('library')

  return <EmptyState icon={<Icon name="prompt" size="lg" />} title={t('empty.templates')} />
}

/** 库里有东西、只是被搜索过滤光时的那一行。 */
export function NoMatch({ label }: { label: string }) {
  return <EmptyState icon={<Icon name="search" size="lg" />} title={label} />
}
