import { ArrowLeft, FolderOpen, ImagePlus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import PageHeader from '../../../components/PageHeader'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { useToolboxStore } from '../store'

export default function ToolboxHeader({
  title,
  onAddImages,
  onAddFolder,
  back = false,
  busy = false,
}: {
  title: ReactNode
  onAddImages: () => void
  onAddFolder: () => void
  back?: boolean
  busy?: boolean
}) {
  const { t } = useTranslation('toolbox')
  const count = useToolboxStore((state) => state.items.length)
  const clear = useToolboxStore((state) => state.clear)
  const closeTool = useToolboxStore((state) => state.closeTool)
  return (
    <header className="shrink-0">
      <PageHeader title={title} />
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3 md:px-6">
        {back && (
          <Button variant="ghost" size="sm" onClick={closeTool}>
            <ArrowLeft />
            {t('page.returnToTools')}
          </Button>
        )}
        {count > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('intake.imported', { count })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={onAddImages}>
            <ImagePlus />
            {t('intake.addImages')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onAddFolder}>
            <FolderOpen />
            {t('intake.addFolder')}
          </Button>
          {count > 0 && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={clear}>
              <Trash2 />
              {t('intake.clearAll')}
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
