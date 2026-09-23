import { X } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { formatLabel } from '../lib/encode'
import { formatBytes, sizeDeltaLabel } from '../lib/naming'
import type { ToolFailure } from '../lib/tool'
import type { ToolResult } from '../lib/useToolResults'
import type { ToolboxItem } from '../store'

function FailureText({ failure }: { failure: ToolFailure }) {
  const { t } = useTranslation('toolbox')
  if (failure.code === 'canvasLimit')
    return (
      <div className="text-destructive">
        {t('result.canvasLimit', { width: failure.width, height: failure.height })}
      </div>
    )
  return <div className="text-destructive">{t(`result.${failure.code}`)}</div>
}

/** 一张图的前后对比。尺寸、体积、涨跌与角标都在这张卡上，底栏只说汇总。 */
export default function ToolResultCard({
  item,
  result,
  onRemove,
}: {
  item: ToolboxItem
  result: ToolResult | undefined
  onRemove: () => void
}) {
  const { t } = useTranslation('toolbox')
  const done = result?.status === 'done' ? result : null
  return (
    <div className="group overflow-hidden rounded-2xl border border-border bg-card">
      <div className="relative aspect-square bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        <img src={done?.url ?? item.url} alt={item.name} className="h-full w-full object-contain" />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('result.remove')}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-background/80 opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-1 p-3 text-xs">
        <div className="truncate font-medium" title={item.name}>
          {item.name}
        </div>
        {result?.status === 'failed' ? (
          <FailureText failure={result.failure} />
        ) : done ? (
          <>
            <div className="text-muted-foreground">
              {item.width}×{item.height} → {done.output.width}×{done.output.height}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">
                {formatBytes(item.size)} →{' '}
                <b className="text-foreground">{formatBytes(done.output.blob.size)}</b>
              </span>
              <span
                className={
                  done.output.blob.size <= item.size ? 'text-emerald-600' : 'text-amber-600'
                }
              >
                {sizeDeltaLabel(item.size, done.output.blob.size)}
              </span>
              {done.output.fellBack && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('result.fellBack', { format: formatLabel(done.output.type) })}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground">{t('result.processing')}</div>
        )}
      </div>
    </div>
  )
}
