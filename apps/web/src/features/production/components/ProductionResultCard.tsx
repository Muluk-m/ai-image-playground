import { ArrowUpRight, Clapperboard, FileText } from 'lucide-react'
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
  const Icon = pane === 'storyboard' ? Clapperboard : FileText
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left"
    >
      <Icon size={18} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t(pane === 'storyboard' ? 'storyboard.title' : 'openScript')}
        </span>
      </span>
      <ArrowUpRight size={17} className="shrink-0 text-muted-foreground" />
    </button>
  )
}
