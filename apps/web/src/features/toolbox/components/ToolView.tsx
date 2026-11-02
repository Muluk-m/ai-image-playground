import { useState } from 'react'
import { useTranslation } from '../../../i18n'
import { formatBytes, outputFileName, sizeDeltaLabel } from '../lib/naming'
import type { EachTool } from '../lib/tool'
import { useToolResults } from '../lib/useToolResults'
import { useToolboxStore } from '../store'
import ToolResultCard from './ToolResultCard'
import ToolShell, { AddTile } from './ToolShell'

/** 单张工具：每张图各出一张，结果卡片网格；点一张看前后对比。 */
export default function ToolView({ tool }: { tool: EachTool }) {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const controller = tool.useController()
  const { results, busy } = useToolResults(items, controller.run)
  const [picked, setPicked] = useState<string | null>(null)

  let before = 0
  let after = 0
  const deliverables = items.flatMap((item) => {
    const result = results.get(item.id)
    if (result?.status !== 'done') return []
    before += item.size
    after += result.output.blob.size
    return [{ name: outputFileName(item.name, result.output.type), blob: result.output.blob }]
  })
  const stats =
    deliverables.length > 0
      ? [
          {
            label: t('stats.images'),
            value: t('stats.imagesValue', { count: deliverables.length }),
          },
          { label: t('stats.before'), value: formatBytes(before) },
          { label: t('stats.after'), value: formatBytes(after) },
          { label: t('stats.delta'), value: sizeDeltaLabel(before, after) },
        ]
      : []

  return (
    <ToolShell
      tool={tool}
      controls={controller.controls}
      deliverables={deliverables}
      stats={stats}
      processing={busy}
      stageHint={t('workbench.compareHint')}
    >
      {({ openFiles }) => (
        <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <ToolResultCard
              key={item.id}
              item={item}
              result={results.get(item.id)}
              onRemove={() => remove(item.id)}
              picked={picked === item.id}
              onPick={(on) => setPicked(on ? item.id : null)}
            />
          ))}
          <AddTile onClick={openFiles} />
        </div>
      )}
    </ToolShell>
  )
}
