import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { CanvasLimitError } from '../lib/canvasLimits'
import { formatBytes } from '../lib/naming'
import type { CombineTool, ToolFailure, ToolOutput } from '../lib/tool'
import { toolSource, useToolboxStore } from '../store'
import { CHECKERBOARD } from './ToolResultCard'
import ToolShell, { type ToolStat } from './ToolShell'

type CombineState =
  | { status: 'pending' }
  | { status: 'done'; outputs: (ToolOutput & { url: string })[] }
  | { status: 'failed'; failure: ToolFailure }

/** 合成工具：左边调顺序，右边是合成结果。参数一停 250ms 就重算，旧结果留到新结果出来。 */
export default function CombineView({ tool }: { tool: CombineTool }) {
  const { t } = useTranslation('toolbox')
  const items = useToolboxStore((state) => state.items)
  const move = useToolboxStore((state) => state.move)
  const remove = useToolboxStore((state) => state.remove)
  const controller = tool.useController()
  const { combine, sourceLimit } = controller
  const used = useMemo(
    () => items.filter((item) => item.decodable).slice(0, sourceLimit ?? items.length),
    [items, sourceLimit],
  )
  const [snapshot, setSnapshot] = useState<{
    used: typeof used
    combine: typeof combine
    value: CombineState
  }>(() => ({ used, combine, value: { status: 'pending' } }))
  const urls = useRef<string[]>([])

  useEffect(() => {
    setSnapshot({ used, combine, value: { status: 'pending' } })
    const sources = used.flatMap((item) => toolSource(item) ?? [])
    if (sources.length === 0) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const outputs = await combine(sources)
        if (cancelled) return
        for (const url of urls.current) URL.revokeObjectURL(url)
        const withUrls = outputs.map((out) => ({ ...out, url: URL.createObjectURL(out.blob) }))
        urls.current = withUrls.map((out) => out.url)
        setSnapshot({ used, combine, value: { status: 'done', outputs: withUrls } })
      } catch (error) {
        if (cancelled) return
        setSnapshot({
          used,
          combine,
          value: {
            status: 'failed',
            failure:
              error instanceof CanvasLimitError
                ? { code: 'canvasLimit', width: error.width, height: error.height }
                : { code: 'failed' },
          },
        })
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [used, combine])

  useEffect(() => {
    const owned = urls
    return () => {
      for (const url of owned.current) URL.revokeObjectURL(url)
    }
  }, [])

  const state =
    snapshot.used === used && snapshot.combine === combine
      ? snapshot.value
      : ({ status: 'pending' } as const)
  const outputs = state.status === 'done' && used.length > 0 ? state.outputs : []
  const name = t(`tool.${tool.id}.name`)
  const deliverables = outputs.map((out, index) => ({
    name: outputs.length > 1 ? `${name}-${index + 1}.jpg` : `${name}.jpg`,
    blob: out.blob,
  }))
  const usedIds = new Set(used.map((item) => item.id))
  const slices = outputs.length > 1

  const stats: ToolStat[] =
    outputs.length === 1
      ? [
          { label: t('stats.images'), value: t('stats.imagesValue', { count: used.length }) },
          { label: t('stats.output'), value: `${outputs[0].width}×${outputs[0].height}` },
          { label: t('stats.size'), value: formatBytes(outputs[0].blob.size) },
        ]
      : slices
        ? [
            { label: t('stats.tiles'), value: t('combine.slices', { count: outputs.length }) },
            {
              label: t('stats.size'),
              value: formatBytes(outputs.reduce((sum, out) => sum + out.blob.size, 0)),
            },
          ]
        : []

  return (
    <ToolShell
      tool={tool}
      controls={controller.controls}
      deliverables={deliverables}
      stats={stats}
      processing={state.status === 'pending' && used.length > 0}
    >
      {({ openFiles }) => (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <ol className="flex shrink-0 gap-2 overflow-x-auto pb-1">
            {items.map((item, index) => (
              <li
                key={item.id}
                className={`flex w-20 shrink-0 flex-col gap-1 rounded-xl border border-border bg-card p-1 ${
                  usedIds.has(item.id) ? '' : 'opacity-40'
                }`}
              >
                <span className="relative">
                  <img
                    src={item.url}
                    alt={item.name}
                    className="aspect-[4/3] w-full rounded-lg object-cover"
                  />
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 font-mono text-label-sm text-white">
                    {index + 1}
                  </span>
                </span>
                <span className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(item.id, -1)}
                    aria-label={t('combine.up')}
                  >
                    <Icon name="chevronLeft" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    onClick={() => remove(item.id)}
                    aria-label={t('result.remove')}
                  >
                    <Icon name="close" className="text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    disabled={index === items.length - 1}
                    onClick={() => move(item.id, 1)}
                    aria-label={t('combine.down')}
                  >
                    <Icon name="chevronRight" />
                  </Button>
                </span>
              </li>
            ))}
            <li className="shrink-0">
              <Button
                variant="ghost"
                type="button"
                onClick={openFiles}
                aria-label={t('workbench.addTile')}
                className="!h-full w-20 rounded-xl border border-dashed border-border text-muted-foreground"
              >
                <Icon name="imageAdd" />
              </Button>
            </li>
          </ol>
          <div
            className={`grid min-h-72 flex-1 place-items-center overflow-auto rounded-2xl border border-border p-4 ${CHECKERBOARD}`}
          >
            {state.status === 'failed' ? (
              <div className="text-sm text-destructive">
                {state.failure.code === 'canvasLimit'
                  ? t('result.canvasLimit', {
                      width: state.failure.width,
                      height: state.failure.height,
                    })
                  : t(`result.${state.failure.code}`)}
              </div>
            ) : slices ? (
              <div
                className="grid w-full max-w-md gap-1.5"
                style={{
                  gridTemplateColumns: `repeat(${controller.previewColumns ?? 3}, minmax(0, 1fr))`,
                }}
              >
                {outputs.map((out) => (
                  <img key={out.url} src={out.url} alt="" className="w-full rounded-sm" />
                ))}
              </div>
            ) : outputs[0] ? (
              <img
                src={outputs[0].url}
                alt=""
                className="max-h-[60vh] max-w-full rounded-lg object-contain"
              />
            ) : (
              <div className="text-sm text-muted-foreground">{t('result.processing')}</div>
            )}
          </div>
        </div>
      )}
    </ToolShell>
  )
}
