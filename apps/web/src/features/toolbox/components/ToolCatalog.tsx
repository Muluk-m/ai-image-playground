import { useState } from 'react'
import PageHeader from '../../../components/patterns/PageHeader'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import { TOOL_GROUPS, TOOLS } from '../lib/registry'
import type { ToolDefinition, ToolGroup } from '../lib/tool'
import { useToolboxStore } from '../store'
import { IntakeActions } from './ToolboxHeader'
import ToolPreview from './ToolPreview'
import { useToolboxIntake } from './useToolboxIntake'

type CatalogTab = 'all' | ToolGroup

function ToolCard({ tool }: { tool: ToolDefinition }) {
  const { t } = useTranslation('toolbox')
  const openTool = useToolboxStore((state) => state.openTool)
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={() => openTool(tool.id)}
      className="group !h-auto !whitespace-normal flex flex-col items-stretch gap-2.5 rounded-2xl p-0 text-left hover:bg-transparent"
    >
      <span className="relative block transition-opacity group-hover:opacity-90">
        <ToolPreview tool={tool.id} />
        <span className="absolute bottom-2.5 right-2.5 grid h-8 w-8 place-items-center rounded-full bg-background/80 text-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Icon name="arrowRight" size="sm" />
        </span>
      </span>
      <span className="flex items-start gap-2.5 px-0.5">
        <Icon name={tool.icon} className="mt-0.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block text-title font-medium">{t(`tool.${tool.id}.name`)}</span>
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            {t(`tool.${tool.id}.description`)}
          </span>
        </span>
      </span>
    </Button>
  )
}

/** 工具目录：每件工具一张效果示意图，点进去就是那件工具的工作台（`/tools/<工具>`）。 */
export default function ToolCatalog() {
  const { t } = useTranslation('toolbox')
  const [tab, setTab] = useState<CatalogTab>('all')
  const { dragging, dropZoneProps, inputs, openFiles, openFolder } = useToolboxIntake()
  const tools = tab === 'all' ? TOOLS : TOOLS.filter((tool) => tool.group === tab)
  const count = (group: CatalogTab) =>
    group === 'all' ? TOOLS.length : TOOLS.filter((tool) => tool.group === group).length
  const tabs = (['all', ...TOOL_GROUPS] as const).map((value) => ({
    value,
    label: (
      <span className="inline-flex items-center gap-1.5">
        {t(`catalog.${value}`)}
        <span className="font-mono text-label-sm opacity-70">{count(value)}</span>
      </span>
    ),
  }))

  return (
    <main
      {...dropZoneProps}
      className={`flex h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--mobile-topbar-height,0px)-var(--app-inset,0px)*2)] flex-col ${dragging ? 'bg-primary/5' : ''}`}
    >
      {inputs}
      <PageHeader title={APP_MODE_LABELS.tools} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-12 md:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="py-8 text-center md:py-10">
            <h2 className="font-display text-xl font-medium">{t('catalog.title')}</h2>
            <p className="mt-1.5 text-body-sm text-muted-foreground">
              {t('catalog.subtitle', { count: TOOLS.length })}
            </p>
          </div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} label={t('catalog.tabs')} />
            <IntakeActions onAddImages={openFiles} onAddFolder={openFolder} />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-6 lg:grid-cols-4">
            {tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
