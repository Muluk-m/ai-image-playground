import { ArrowLeft, Download, FolderOpen, ImagePlus, SquareArrowOutUpRight } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { downloadImages, sendImagesToComposer } from '../lib/deliver'
import { formatBytes, outputFileName, sizeDeltaLabel } from '../lib/naming'
import type { ToolDefinition } from '../lib/tool'
import { useToolResults } from '../lib/useToolResults'
import { useToolboxStore } from '../store'
import ToolResultCard from './ToolResultCard'
import { useToolboxIntake } from './useToolboxIntake'

/** 一件工具的页面：顶栏、只属于这件工具的参数行、结果卡片网格、汇总底栏。 */
export default function ToolView({ tool }: { tool: ToolDefinition }) {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const clear = useToolboxStore((state) => state.clear)
  const closeTool = useToolboxStore((state) => state.closeTool)
  const { dragging, dropZoneProps, inputs, openFiles, openFolder } = useToolboxIntake()
  const controller = tool.useController()
  const { results, busy } = useToolResults(items, controller.run)
  const Icon = tool.icon

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
    <main {...dropZoneProps} className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {inputs}
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-2 border-b border-border py-2.5 pl-3 pr-16 md:pr-60">
        <Button variant="ghost" size="sm" onClick={closeTool}>
          <ArrowLeft />
          {t('page.back')}
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="flex items-center gap-2 text-[15px] font-medium">
          <Icon className="h-4 w-4 text-primary" />
          {t(`tool.${tool.id}.name`)}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={openFiles}>
            <ImagePlus />
            {t('intake.addImages')}
          </Button>
          <Button variant="outline" size="sm" onClick={openFolder}>
            <FolderOpen />
            {t('intake.addFolder')}
          </Button>
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear}>
              {t('intake.clear')}
            </Button>
          )}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-end gap-5 border-b border-border bg-muted/30 px-5 py-3">
        {controller.controls}
      </div>
      {items.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <div
            className={`flex w-full max-w-xl flex-col items-center gap-4 rounded-3xl border-2 border-dashed px-8 py-16 ${
              dragging ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <Icon className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">{t('intake.hint')}</div>
            <div className="flex gap-2">
              <Button onClick={openFiles}>{t('intake.chooseImages')}</Button>
              <Button variant="outline" onClick={openFolder}>
                {t('intake.chooseFolder')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
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
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-5 py-3">
        <span className="text-sm tabular-nums">
          {busy
            ? t('footer.processing')
            : deliverables.length > 0
              ? t('footer.summary', {
                  count: deliverables.length,
                  before: formatBytes(before),
                  after: formatBytes(after),
                  delta: sizeDeltaLabel(before, after),
                })
              : ''}
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            variant="outline"
            disabled={deliverables.length === 0}
            onClick={() => void sendImagesToComposer(deliverables)}
          >
            <SquareArrowOutUpRight />
            {t('footer.sendToComposer')}
          </Button>
          <Button
            disabled={deliverables.length === 0}
            onClick={() => void downloadImages(deliverables, `${t(`tool.${tool.id}.name`)}.zip`)}
          >
            <Download />
            {deliverables.length > 1
              ? t('footer.downloadAll', { count: deliverables.length })
              : t('footer.download')}
          </Button>
        </span>
      </div>
    </main>
  )
}
