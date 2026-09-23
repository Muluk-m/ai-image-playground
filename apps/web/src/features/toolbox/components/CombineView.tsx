import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { CanvasLimitError } from '../lib/canvasLimits'
import { formatBytes } from '../lib/naming'
import type { CombineTool, ToolFailure, ToolOutput } from '../lib/tool'
import { toolSource, useToolboxStore } from '../store'
import ToolShell from './ToolShell'

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

  return (
    <ToolShell
      tool={tool}
      controls={controller.controls}
      deliverables={deliverables}
      summary={
        outputs.length === 1
          ? `${outputs[0].width}×${outputs[0].height} · ${formatBytes(outputs[0].blob.size)}`
          : slices
            ? t('combine.slices', { count: outputs.length })
            : ''
      }
    >
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-1.5 overflow-y-auto border-r border-border p-3">
          {items.map((item) => (
            <div
              key={item.id}
              className={`flex items-center gap-2 rounded-xl border border-border p-1.5 ${
                usedIds.has(item.id) ? '' : 'opacity-40'
              }`}
            >
              <img src={item.url} alt={item.name} className="h-10 w-10 rounded-lg object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
              <span className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(item.id, -1)}
                  aria-label={t('combine.up')}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(item.id, 1)}
                  aria-label={t('combine.down')}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </span>
              <button type="button" onClick={() => remove(item.id)} aria-label={t('result.remove')}>
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </aside>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
          {state.status === 'failed' ? (
            <div className="grid h-full place-items-center text-sm text-destructive">
              {state.failure.code === 'canvasLimit'
                ? t('result.canvasLimit', {
                    width: state.failure.width,
                    height: state.failure.height,
                  })
                : t(`result.${state.failure.code}`)}
            </div>
          ) : slices ? (
            <div
              className="mx-auto grid max-w-xl gap-1.5"
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
              className="mx-auto max-h-[70vh] w-auto rounded-lg shadow-lg"
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              {t('result.processing')}
            </div>
          )}
        </div>
      </div>
    </ToolShell>
  )
}
