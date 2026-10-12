import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

export default function NewAssetButton({
  onClick,
  className = '',
}: {
  onClick: () => void
  className?: string
}) {
  const { t } = useTranslation('library')

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={`h-auto gap-1 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/20 hover:text-primary ${className}`}
    >
      <Icon name="add" />
      {t('asset.new')}
    </Button>
  )
}
