import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

export default function ProductionResultCard({
  title,
  onOpen,
  pane,
}: {
  pane?: 'script' | 'storyboard'
  title: string
  onOpen: () => void
}) {
  const { t } = useTranslation('production')
  const icon = pane === 'storyboard' ? 'storyboard' : 'script'
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={onOpen}
      className="h-auto whitespace-normal flex w-full items-center gap-3 rounded-xl border border-border p-4 text-left"
    >
      <Icon name={icon} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t(pane === 'storyboard' ? 'storyboard.title' : 'openScript')}
        </span>
      </span>
      <Icon name="arrowRight" className="shrink-0 text-muted-foreground" />
    </Button>
  )
}
