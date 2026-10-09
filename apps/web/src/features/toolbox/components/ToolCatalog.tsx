import { X } from 'lucide-react'
import PageHeader from '../../../components/PageHeader'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import { TOOL_GROUPS, TOOLS } from '../lib/registry'
import type { ToolDefinition } from '../lib/tool'
import { useToolboxStore } from '../store'
import { useToolboxIntake } from './useToolboxIntake'

function ToolCard({ tool }: { tool: ToolDefinition }) {
  const { t } = useTranslation('toolbox')
  const openTool = useToolboxStore((state) => state.openTool)
  const Icon = tool.icon
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={() => openTool(tool.id)}
      className="!h-auto !whitespace-normal justify-start group flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="block text-title font-medium">{t(`tool.${tool.id}.name`)}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t(`tool.${tool.id}.options`)}
        </span>
      </span>
    </Button>
  )
}

/** 工具目录：先选一件工具，进去只做这一件事。卡片只写名字与选项。 */
export default function ToolCatalog() {
  const { t } = useTranslation('toolbox')
  const count = useToolboxStore((state) => state.items.length)
  const clear = useToolboxStore((state) => state.clear)
  const { dragging, dropZoneProps, inputs } = useToolboxIntake()

  return (
    <main
      {...dropZoneProps}
      className={`flex h-[calc(100dvh-var(--mobile-nav-height,0px))] flex-col ${dragging ? 'bg-primary/5' : ''}`}
    >
      {inputs}
      <PageHeader title={APP_MODE_LABELS.tools}>
        {count > 0 && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs">
            {t('intake.imported', { count })}
            <Button
              variant="ghost"
              type="button"
              onClick={clear}
              aria-label={t('intake.clear')}
              className="ml-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </Button>
          </span>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl space-y-8">
          {TOOL_GROUPS.map((group) => {
            const tools = TOOLS.filter((tool) => tool.group === group)
            if (tools.length === 0) return null
            return (
              <section key={group}>
                <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                  {t(`catalog.${group}`)}
                </h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {tools.map((tool) => (
                    <ToolCard key={tool.id} tool={tool} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </main>
  )
}
