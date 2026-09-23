import { useTranslation } from '../../../i18n'
import { formatBytes, outputFileName, sizeDeltaLabel } from '../lib/naming'
import type { EachTool } from '../lib/tool'
import { useToolResults } from '../lib/useToolResults'
import { useToolboxStore } from '../store'
import ToolResultCard from './ToolResultCard'
import ToolShell from './ToolShell'

/** 单张工具：每张图各出一张，结果卡片网格。 */
export default function ToolView({ tool }: { tool: EachTool }) {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const controller = tool.useController()
  const { results, busy } = useToolResults(items, controller.run)

  let before = 0
  let after = 0
  const deliverables = items.flatMap((item) => {
    const result = results.get(item.id)
    if (result?.status !== 'done') return []
    before += item.size
    after += result.output.blob.size
    return [{ name: outputFileName(item.name, result.output.type), blob: result.output.blob }]
  })

  return (
    <ToolShell
      tool={tool}
      controls={controller.controls}
      deliverables={deliverables}
      summary={
        busy
          ? t('footer.processing')
          : deliverables.length > 0
            ? t('footer.summary', {
                count: deliverables.length,
                before: formatBytes(before),
                after: formatBytes(after),
                delta: sizeDeltaLabel(before, after),
              })
            : ''
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <ToolResultCard
              key={item.id}
              item={item}
              result={results.get(item.id)}
              onRemove={() => remove(item.id)}
            />
          ))}
        </div>
      </div>
    </ToolShell>
  )
}
