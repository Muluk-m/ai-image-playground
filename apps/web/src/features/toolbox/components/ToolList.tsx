import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { TOOL_GROUPS, TOOLS } from '../lib/registry'
import type { ToolId } from '../lib/tool'
import { useToolboxStore } from '../store'

/** 工作台左侧的工具列表。换工具只换右边的处理方式，导入的图一张不动。 */
export default function ToolList({ active }: { active: ToolId }) {
  const { t } = useTranslation('toolbox')
  const openTool = useToolboxStore((state) => state.openTool)
  return (
    <nav
      aria-label={t('workbench.tools')}
      className="flex shrink-0 gap-1 overflow-x-auto px-3 py-2 lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:py-3"
    >
      {TOOL_GROUPS.map((group) => (
        <div key={group} className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5">
          <div className="hidden px-2.5 pb-1.5 pt-2.5 text-label-sm text-muted-foreground lg:block">
            {t(`catalog.${group}`)}
          </div>
          {TOOLS.filter((tool) => tool.group === group).map((tool) => {
            const current = tool.id === active
            return (
              <Button
                key={tool.id}
                variant="ghost"
                size="sm"
                aria-current={current ? 'page' : undefined}
                onClick={() => !current && openTool(tool.id)}
                className={`shrink-0 justify-start gap-2.5 px-2.5 text-body-sm font-normal ${
                  current
                    ? 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
                    : 'text-muted-foreground'
                }`}
              >
                <Icon name={tool.icon} />
                {t(`tool.${tool.id}.name`)}
              </Button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
