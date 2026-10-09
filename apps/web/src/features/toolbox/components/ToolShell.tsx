import { Download, SquareArrowOutUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { type DeliverableImage, downloadImages, sendImagesToComposer } from '../lib/deliver'
import type { ToolDefinition } from '../lib/tool'
import { useToolboxStore } from '../store'
import ToolboxHeader from './ToolboxHeader'
import { useToolboxIntake } from './useToolboxIntake'

/**
 * 工具页的外壳：顶栏、只属于这件工具的参数行、主体（没图时是拖放区）、汇总底栏。
 * 单张工具与合成工具只在主体和汇总上不同。
 */
export default function ToolShell({
  tool,
  controls,
  summary,
  deliverables,
  children,
}: {
  tool: ToolDefinition
  controls: ReactNode
  summary: ReactNode
  deliverables: readonly DeliverableImage[]
  children: ReactNode
}) {
  const { t } = useTranslation('toolbox')
  const count = useToolboxStore((state) => state.items.length)
  const { dragging, dropZoneProps, inputs, openFiles, openFolder } = useToolboxIntake()
  const Icon = tool.icon
  const name = t(`tool.${tool.id}.name`)

  return (
    <main
      {...dropZoneProps}
      className="flex h-[calc(100dvh-var(--mobile-nav-height,0px))] flex-col"
    >
      {inputs}
      <ToolboxHeader
        back
        onAddImages={openFiles}
        onAddFolder={openFolder}
        title={
          <>
            <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
            {name}
          </>
        }
      />
      <div className="flex shrink-0 flex-wrap items-end gap-5 border-b border-border bg-muted/30 px-6 py-3">
        {controls}
      </div>
      {count === 0 ? (
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
        children
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-5 py-3">
        <span className="text-sm tabular-nums">{summary}</span>
        <span className="ml-auto flex gap-2">
          <Button
            variant="outline"
            className="gap-1.5 px-2 sm:gap-2 sm:px-4"
            disabled={deliverables.length === 0}
            onClick={() => void sendImagesToComposer(deliverables)}
          >
            <SquareArrowOutUpRight />
            {t('footer.sendToComposer')}
          </Button>
          <Button
            className="gap-1.5 px-2 sm:gap-2 sm:px-4"
            disabled={deliverables.length === 0}
            onClick={() => void downloadImages(deliverables, `${name}.zip`)}
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
