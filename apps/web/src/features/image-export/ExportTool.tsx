import { useMemo } from 'react'
import Badge from '../../components/patterns/Badge'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { OverflowText } from '../../components/ui/overflowTitle'
import { useTranslation } from '../../i18n'
import { CHECKERBOARD } from '../toolbox/components/ToolResultCard'
import ToolShell, { AddTile, type ToolStat } from '../toolbox/components/ToolShell'
import { formatLabel } from '../toolbox/lib/encode'
import { resizeTool } from '../toolbox/lib/registry'
import { type ToolboxItem, useToolboxStore } from '../toolbox/store'
import ExportControls, { ExportStatusMessages } from './ExportControls'
import { type ExportSettings, exportSize } from './export'
import { originalBlob } from './sources'
import { useExportState } from './useExportState'

function ResizeCard({
  item,
  settings,
  invalid,
  busy,
  onRemove,
}: {
  item: ToolboxItem
  settings: ExportSettings
  invalid: boolean
  busy: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation('toolbox')
  const singleRow = settings.rows.length === 1 ? settings.rows[0] : null
  const singleOutput =
    item.decodable && singleRow && !invalid
      ? exportSize(
          item.width,
          item.height,
          settings.mode,
          settings.value,
          singleRow.scale,
          settings.stretch,
        )
      : null
  const changed =
    singleOutput !== null &&
    (singleOutput.width !== item.width || singleOutput.height !== item.height)

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className={`relative aspect-[4/3] ${CHECKERBOARD}`}>
        <img src={item.url} alt={item.name} className="h-full w-full object-contain" />
        <Button
          variant="outline"
          size="icon-xs"
          type="button"
          disabled={busy}
          onClick={onRemove}
          aria-label={t('result.remove')}
          className="absolute right-2 top-2 opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Icon name="close" />
        </Button>
      </div>
      <div className="space-y-1 px-3 py-2.5 text-xs">
        <OverflowText as="div" text={item.name} className="truncate font-medium" />
        {!item.decodable ? (
          <div className="text-destructive">{t('export.undecodable')}</div>
        ) : singleRow ? (
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-label-sm tabular-nums">
              {invalid ? (
                <>
                  <span className="text-muted-foreground">
                    {item.width} × {item.height}
                  </span>
                  <Icon name="arrowRight" size="xs" className="shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('export.pendingSize')}</span>
                </>
              ) : changed && singleOutput ? (
                <>
                  <span className="text-muted-foreground">
                    {item.width} × {item.height}
                  </span>
                  <Icon name="arrowRight" size="xs" className="shrink-0 text-muted-foreground" />
                  <span className="font-medium text-primary">
                    {singleOutput.width} × {singleOutput.height} px
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {item.width} × {item.height} px
                </span>
              )}
            </div>
            <Badge tone={changed ? 'primary' : 'neutral'} className="shrink-0 font-mono">
              {singleRow.scale === 1
                ? formatLabel(singleRow.format)
                : `${singleRow.scale}x ${formatLabel(singleRow.format)}`}
            </Badge>
          </div>
        ) : (
          <>
            <div className="font-mono text-label-sm text-muted-foreground tabular-nums">
              {item.width} × {item.height} px
            </div>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {settings.rows.map((row) => {
                const output = !invalid
                  ? exportSize(
                      item.width,
                      item.height,
                      settings.mode,
                      settings.value,
                      row.scale,
                      settings.stretch,
                    )
                  : null
                return (
                  <span
                    key={row.id}
                    className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-label-sm tabular-nums"
                  >
                    <span className="text-muted-foreground">
                      {row.scale}x {formatLabel(row.format)}
                    </span>
                    <span className="text-primary">
                      {output ? `${output.width}×${output.height}` : t('export.pendingSize')}
                    </span>
                  </span>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 尺寸调整：共用三栏工作台；舞台卡片直接预览输出尺寸，右侧专注参数与汇总，底栏统一放回输入框与导出。 */
export default function ExportTool() {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const remove = useToolboxStore((state) => state.remove)
  const sources = useMemo(
    () =>
      items
        .filter((item) => item.decodable)
        .map((item) => ({
          id: item.id,
          name: item.name,
          media: 'image' as const,
          preview: item.url,
          width: item.width,
          height: item.height,
          // HEIC 的 URL 是已解码的无损 PNG；普通图片的 URL 仍指向原文件。
          load: (signal?: AbortSignal) => originalBlob(item.url, signal),
        })),
    [items],
  )
  const state = useExportState({ sources })
  const {
    settings,
    progress,
    busy,
    busyAction,
    error,
    done,
    images,
    count,
    locked,
    invalid,
    hasJpeg,
    hasVideo,
    canExport,
    canSendToComposer,
    outputSizes,
    sharedAxis,
    runExport,
    runSendToComposer,
  } = state

  const stats: ToolStat[] = (() => {
    if (images === 0) return []
    let outputValue: string
    if (invalid) {
      outputValue = t('export.pendingSize')
    } else if (settings.rows.length > 1) {
      outputValue = t('export.specsCount', { count: settings.rows.length })
    } else {
      const outputs = outputSizes(settings.rows[0].scale)
      const width = sharedAxis('width', outputs)
      const height = sharedAxis('height', outputs)
      outputValue =
        width && height
          ? `${width} × ${height} px`
          : t(locked ? 'export.batchHint' : 'export.multipleValues')
    }
    return [
      { label: t('stats.images'), value: t('stats.imagesValue', { count: images }) },
      { label: t('stats.output'), value: outputValue },
      {
        label: t('export.files'),
        value: count > 1 ? t('export.filesZip', { count }) : t('export.filesValue', { count }),
      },
    ]
  })()

  return (
    <ToolShell
      tool={resizeTool}
      busy={busy}
      processing={busy}
      panelClassName="lg:w-80"
      stats={stats}
      canDownload={canExport}
      canSendToComposer={canSendToComposer}
      downloadBusy={busyAction === 'export'}
      sendToComposerBusy={busyAction === 'composer'}
      downloadLabel={
        busyAction === 'export'
          ? t('export.progress', { done: progress, total: sources.length })
          : count > 0
            ? t('export.action', { count })
            : t('footer.download')
      }
      footerStatus={
        busy
          ? t('export.progress', { done: progress, total: sources.length })
          : count > 1
            ? t('export.zipHint')
            : undefined
      }
      onDownload={() => void runExport()}
      onSendToComposer={() => void runSendToComposer()}
      controls={
        <>
          <ExportControls state={state} />
          <ExportStatusMessages hasJpeg={hasJpeg} hasVideo={hasVideo} error={error} done={done} />
        </>
      }
    >
      {({ openFiles }) => (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {items.map((item) => (
            <ResizeCard
              key={item.id}
              item={item}
              settings={settings}
              invalid={invalid}
              busy={busy}
              onRemove={() => remove(item.id)}
            />
          ))}
          {!busy && <AddTile onClick={openFiles} />}
        </div>
      )}
    </ToolShell>
  )
}
