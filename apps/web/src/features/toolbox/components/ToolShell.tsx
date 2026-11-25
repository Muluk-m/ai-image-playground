import { type ReactNode, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { type DeliverableImage, downloadImages, sendImagesToComposer } from '../lib/deliver'
import type { ToolDefinition } from '../lib/tool'
import { useToolboxStore } from '../store'
import ToolboxHeader from './ToolboxHeader'
import ToolList from './ToolList'
import { useToolboxIntake } from './useToolboxIntake'

export interface ToolStat {
  label: string
  value: ReactNode
}

/** 参数栏底部的汇总框：张数、前后体积、变化。 */
function StatBox({ stats }: { stats: readonly ToolStat[] }) {
  return (
    <dl className="mt-auto space-y-1 rounded-xl border border-border bg-card p-3 text-xs">
      {stats.map((stat) => (
        <div key={stat.label} className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">{stat.label}</dt>
          <dd className="min-w-0 truncate text-right font-mono tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 网格最后那一格：拖入或点击继续添加。 */
export function AddTile({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('toolbox')
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onClick}
      className="!h-auto min-h-40 flex-col gap-1.5 rounded-2xl border border-dashed border-border text-xs font-normal text-muted-foreground"
    >
      <Icon name="imageAdd" size="md" />
      {t('workbench.addTile')}
    </Button>
  )
}

/**
 * 每件工具共用的工作台：顶栏面包屑与导入，左边工具列表，中间图片，右边这件工具的参数与汇总，
 * 底栏是带回创作输入框与下载。整页只有底栏的下载是实心芽绿。
 */
export default function ToolShell({
  tool,
  controls,
  stats = [],
  summary,
  deliverables = [],
  children,
  downloadLabel,
  stageHint,
  busy = false,
  processing = false,
  footer = true,
  footerStatus,
  showSendToComposer = true,
  canDownload,
  downloadBusy = false,
  onDownload,
  panelClassName = 'lg:w-72',
  panelBody,
}: {
  tool: ToolDefinition
  controls?: ReactNode
  stats?: readonly ToolStat[]
  /** 汇总框里放自定义内容时用（旋转只说无损与输出尺寸）。 */
  summary?: ReactNode
  deliverables?: readonly DeliverableImage[]
  children: (intake: { openFiles: () => void }) => ReactNode
  downloadLabel?: string
  stageHint?: string
  busy?: boolean
  processing?: boolean
  footer?: boolean
  footerStatus?: ReactNode
  showSendToComposer?: boolean
  canDownload?: boolean
  downloadBusy?: boolean
  onDownload?: () => void
  panelClassName?: string
  /** 整块替换参数栏时使用。 */
  panelBody?: ReactNode
}) {
  const { t } = useTranslation('toolbox')
  const count = useToolboxStore((state) => state.items.length)
  const { dragging, importing, dropZoneProps, inputs, openFiles, openFolder } =
    useToolboxIntake(busy)
  const name = t(`tool.${tool.id}.name`)
  const [localDownloading, setLocalDownloading] = useState(false)
  const [sending, setSending] = useState(false)
  const downloadingRef = useRef(false)
  const sendingRef = useRef(false)
  const isDownloading = downloadBusy || localDownloading
  const downloadReady = (canDownload ?? deliverables.length > 0) && !isDownloading

  const handleDownload = () => {
    if (onDownload) {
      onDownload()
      return
    }
    if (downloadingRef.current || deliverables.length === 0) return
    downloadingRef.current = true
    setLocalDownloading(true)
    void Promise.resolve(downloadImages(deliverables, `${name}.zip`))
      .catch(() => {
        useStore.getState().showToast(t('result.failed'), 'error')
      })
      .finally(() => {
        downloadingRef.current = false
        setLocalDownloading(false)
      })
  }

  const handleSendToComposer = () => {
    if (sendingRef.current || deliverables.length === 0) return
    sendingRef.current = true
    setSending(true)
    void Promise.resolve(sendImagesToComposer(deliverables))
      .catch(() => {
        useStore.getState().showToast(t('result.failed'), 'error')
      })
      .finally(() => {
        sendingRef.current = false
        setSending(false)
      })
  }

  return (
    <main
      {...dropZoneProps}
      className="flex h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--mobile-topbar-height,0px)-var(--app-inset,0px)*2)] flex-col"
    >
      {inputs}
      <ToolboxHeader
        tool={tool}
        busy={busy}
        importing={importing}
        onAddImages={openFiles}
        onAddFolder={openFolder}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="shrink-0 border-b border-border lg:w-48 lg:border-b-0 lg:border-r">
          <ToolList active={tool.id} busy={busy} />
        </div>
        <section
          className={`flex min-w-0 flex-col p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-5 ${
            dragging ? 'bg-primary/5' : ''
          }`}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t('workbench.count', { count })}
              {count > 0 && stageHint ? ` · ${stageHint}` : ''}
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <Icon name="lock" size="xs" />
              {t('workbench.local')}
            </span>
          </div>
          {count === 0 ? (
            <div
              className={`flex min-h-72 flex-1 flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-12 text-center ${
                dragging ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <Icon name={tool.icon} size="lg" className="text-muted-foreground" />
              <div className="text-sm text-muted-foreground">{t('intake.hint')}</div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={openFiles}>
                  <Icon name="imageAdd" />
                  {t('intake.chooseImages')}
                </Button>
                <Button variant="ghost" onClick={openFolder}>
                  <Icon name="folder" />
                  {t('intake.chooseFolder')}
                </Button>
              </div>
            </div>
          ) : (
            children({ openFiles })
          )}
        </section>
        <aside
          className={`flex min-w-0 shrink-0 flex-col border-t border-border bg-card/40 lg:min-h-0 lg:overflow-hidden lg:border-l lg:border-t-0 ${panelClassName}`}
        >
          {panelBody ?? (
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-x-hidden p-4 lg:overflow-y-auto">
              <h2 className="text-title font-medium">{t('workbench.settings', { name })}</h2>
              <div className="flex min-w-0 flex-col gap-5 [&_fieldset]:min-w-0 [&_fieldset]:w-full">
                {controls}
              </div>
              {stats.length > 0 && <StatBox stats={stats} />}
              {summary != null && (
                <div className="mt-auto rounded-xl border border-border bg-card p-3">{summary}</div>
              )}
            </div>
          )}
        </aside>
      </div>
      {footer && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-4 py-3 md:px-5">
          <span
            className={`min-w-0 flex-1 text-xs text-muted-foreground ${processing || footerStatus ? '' : 'hidden sm:block'}`}
          >
            {footerStatus ?? (processing ? t('footer.processing') : t('workbench.footerHint'))}
          </span>
          <span className="ml-auto flex flex-wrap gap-2">
            {showSendToComposer && (
              <Button
                variant="outline"
                disabled={deliverables.length === 0 || sending}
                onClick={handleSendToComposer}
              >
                <Icon
                  name={sending ? 'loading' : 'sendToComposer'}
                  className={sending ? 'animate-spin' : undefined}
                />
                {t('footer.sendToComposer')}
              </Button>
            )}
            <Button disabled={!downloadReady} onClick={handleDownload}>
              <Icon
                name={isDownloading ? 'loading' : 'download'}
                className={isDownloading ? 'animate-spin' : undefined}
              />
              {downloadLabel ??
                (deliverables.length > 1
                  ? t('footer.downloadAll', { count: deliverables.length })
                  : t('footer.download'))}
            </Button>
          </span>
        </div>
      )}
    </main>
  )
}
