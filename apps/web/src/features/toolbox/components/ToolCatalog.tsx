import { X } from 'lucide-react'
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
    <button
      type="button"
      onClick={() => openTool(tool.id)}
      className="group flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
    >
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="block text-[15px] font-medium">{t(`tool.${tool.id}.name`)}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t(`tool.${tool.id}.options`)}
        </span>
      </span>
    </button>
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
      className={`flex h-[calc(100dvh-3.5rem)] flex-col ${dragging ? 'bg-primary/5' : ''}`}
    >
      {inputs}
      <div className="studio-page-head flex shrink-0 items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.tools}</h1>
        {count > 0 && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs">
            {t('intake.imported', { count })}
            <button
              type="button"
              onClick={clear}
              aria-label={t('intake.clear')}
              className="ml-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-8">
        <div className="mx-auto max-w-5xl space-y-8">
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
