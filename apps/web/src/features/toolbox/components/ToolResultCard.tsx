import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { OverflowText } from '../../../components/ui/overflowTitle'
import { useTranslation } from '../../../i18n'
import { formatLabel } from '../lib/encode'
import { formatBytes, sizeDeltaLabel } from '../lib/naming'
import type { ToolFailure } from '../lib/tool'
import type { ToolResult } from '../lib/useToolResults'
import type { ToolboxItem } from '../store'
import CompareView from './CompareView'

export function FailureText({ failure }: { failure: ToolFailure }) {
  const { t } = useTranslation('toolbox')
  if (failure.code === 'canvasLimit')
    return (
      <div className="text-destructive">
        {t('result.canvasLimit', { width: failure.width, height: failure.height })}
      </div>
    )
  return <div className="text-destructive">{t(`result.${failure.code}`)}</div>
}

export const CHECKERBOARD =
  'bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]'

/** 一张图的结果卡：点缩略图进入前后对比；尺寸、体积与提示都在卡上。 */
export default function ToolResultCard({
  item,
  result,
  onRemove,
  picked = false,
  onPick,
}: {
  item: ToolboxItem
  result: ToolResult | undefined
  onRemove: () => void
  picked?: boolean
  onPick?: (picked: boolean) => void
}) {
  const { t } = useTranslation('toolbox')
  const done = result?.status === 'done' ? result : null
  const resized = done && (done.output.width !== item.width || done.output.height !== item.height)
  return (
    <div
      className={`group overflow-hidden rounded-2xl border bg-card ${
        picked && done ? 'border-primary/70' : 'border-border'
      }`}
    >
      <div className={`relative aspect-[4/3] ${CHECKERBOARD}`}>
        {picked && done ? (
          <CompareView before={item.url} after={done.url} onExit={() => onPick?.(false)} />
        ) : (
          <>
            <img
              src={done?.url ?? item.url}
              alt={item.name}
              className="h-full w-full object-contain"
            />
            {done && onPick && (
              <Button
                variant="ghost"
                type="button"
                aria-label={t('compare.open', { name: item.name })}
                onClick={() => onPick(true)}
                className="absolute inset-0 !h-full rounded-none p-0 hover:bg-foreground/5"
              />
            )}
          </>
        )}
        <Button
          variant="outline"
          size="icon-xs"
          type="button"
          onClick={onRemove}
          aria-label={t('result.remove')}
          className="absolute right-2 top-2 z-10 opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Icon name="close" />
        </Button>
      </div>
      <div className="space-y-0.5 px-3 py-2.5 text-xs">
        <OverflowText as="div" text={item.name} className="truncate" />
        {result?.status === 'failed' ? (
          <FailureText failure={result.failure} />
        ) : done ? (
          <>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-label-sm text-muted-foreground">
              <span className="whitespace-nowrap">
                {formatBytes(item.size)} →{' '}
                <span className="text-primary">{formatBytes(done.output.blob.size)}</span>
              </span>
              <span
                className={`whitespace-nowrap ${
                  done.output.blob.size <= item.size ? 'text-success' : 'text-warning'
                }`}
              >
                {sizeDeltaLabel(item.size, done.output.blob.size)}
              </span>
            </div>
            {resized && (
              <div className="whitespace-nowrap font-mono text-label-sm text-muted-foreground">
                {item.width}×{item.height} → {done.output.width}×{done.output.height}
              </div>
            )}
            {(done.output.notes?.length || done.output.fellBack) && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {done.output.notes?.map((note) => (
                  <span
                    key={note}
                    className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-label-sm text-warning"
                  >
                    {t(`result.note.${note}`)}
                  </span>
                ))}
                {done.output.fellBack && (
                  <span className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-label-sm text-warning">
                    {t('result.fellBack', { format: formatLabel(done.output.type) })}
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="text-muted-foreground">{t('result.processing')}</div>
        )}
      </div>
    </div>
  )
}
