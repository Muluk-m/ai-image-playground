import PageHeader from '../../../components/patterns/PageHeader'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import type { ToolDefinition } from '../lib/tool'
import { useToolboxStore } from '../store'

/** 导入与清空。目录与工作台共用；主色按钮留给工作台底栏的下载，这里只用描边与 ghost。 */
export function IntakeActions({
  onAddImages,
  onAddFolder,
  busy = false,
}: {
  onAddImages: () => void
  onAddFolder: () => void
  busy?: boolean
}) {
  const { t } = useTranslation('toolbox')
  const count = useToolboxStore((state) => state.items.length)
  const clear = useToolboxStore((state) => state.clear)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {count > 0 && (
        <span className="mr-1 hidden whitespace-nowrap text-xs sm:inline text-muted-foreground tabular-nums">
          {t('intake.imported', { count })}
        </span>
      )}
      <Button variant="outline" size="sm" disabled={busy} onClick={onAddImages}>
        <Icon name="imageAdd" />
        {t('intake.addImages')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onAddFolder}>
        <Icon name="folder" />
        {t('intake.addFolder')}
      </Button>
      {count > 0 && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={clear}>
          <Icon name="delete" />
          {t('intake.clear')}
        </Button>
      )}
    </div>
  )
}

/** 工具页顶栏：面包屑「工具箱 › 工具名」，右侧是导入。点「工具箱」回目录，导入的图保留。 */
export default function ToolboxHeader({
  tool,
  onAddImages,
  onAddFolder,
  busy = false,
}: {
  tool: ToolDefinition
  onAddImages: () => void
  onAddFolder: () => void
  busy?: boolean
}) {
  const { t } = useTranslation('toolbox')
  const closeTool = useToolboxStore((state) => state.closeTool)
  return (
    <PageHeader
      className="shrink-0"
      leading={
        <nav aria-label={APP_MODE_LABELS.tools} className="flex min-w-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-title font-medium text-muted-foreground"
            onClick={closeTool}
          >
            {APP_MODE_LABELS.tools}
          </Button>
          <Icon name="chevronRight" size="xs" className="shrink-0 text-muted-foreground" />
          <h1 aria-current="page" className="truncate px-1 font-display text-title font-semibold">
            {t(`tool.${tool.id}.name`)}
          </h1>
        </nav>
      }
    >
      <div className="ml-auto">
        <IntakeActions onAddImages={onAddImages} onAddFolder={onAddFolder} busy={busy} />
      </div>
    </PageHeader>
  )
}
