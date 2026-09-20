import { useMemo } from 'react'
import { CopyIcon, SparkleIcon } from '../../../components/icons'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { useInspirationStore } from '../store'

export default function InspirationDetail() {
  const detailItemId = useInspirationStore((s) => s.detailItemId)
  const closeDetail = useInspirationStore((s) => s.closeDetail)
  const items = useInspirationStore((s) => s.items)
  const showToast = useStore((s) => s.showToast)
  const { t } = useTranslation(['inspiration', 'common'])

  const item = useMemo(
    () => items.find((i) => i.id === detailItemId) ?? null,
    [items, detailItemId],
  )

  const promptDisplay = useMemo(() => formatPrompt(item?.prompt ?? ''), [item?.prompt])

  if (!item) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      showToast(t('detail.promptCopied'), 'success')
    } catch {
      showToast(t('detail.copyFailed'), 'error')
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-3xl bg-card animate-modal-in">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 border-b border-border p-5">
        <button
          type="button"
          onClick={closeDetail}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {t('detail.back')}
        </button>
        <div className="text-xs text-muted-foreground">{item.recommendedProvider}</div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          {/* 左：大图 — 点击在新标签页打开原图 */}
          <a
            href={item.imageUrl ?? item.thumbnailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative block overflow-hidden rounded-2xl bg-muted"
            title={t('detail.openOriginalHint')}
          >
            <img
              src={item.imageUrl ?? item.thumbnailUrl}
              alt={item.title}
              className="w-full h-auto object-contain transition-transform duration-200 group-hover:scale-[1.01]"
              loading="lazy"
            />
            <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/50 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
              {t('detail.openOriginal')}
            </span>
          </a>

          {/* 右：信息 */}
          <div className="flex flex-col gap-4">
            <div>
              <h4 className="text-xl font-bold text-foreground">{item.title}</h4>
              {item.description && (
                <p className="mt-1.5 text-sm text-muted-foreground">{item.description}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-primary/10 px-2 py-1 text-primary">
                {item.category}
              </span>
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
                {item.recommendedModel}
              </span>
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
                {item.params.size}
              </span>
              {item.params.quality && (
                <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
                  quality: {item.params.quality}
                </span>
              )}
              {item.params.n && item.params.n > 1 && (
                <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
                  n: {item.params.n}
                </span>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>{t('detail.promptLabel')}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label={t('detail.copyPrompt')}
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  {t('common:action.copy')}
                </button>
              </div>
              <pre
                data-selectable-text
                className="max-h-[40vh] overflow-auto rounded-xl border border-border/60 bg-card/80 p-3 text-xs leading-relaxed text-foreground"
              >
                <code>{promptDisplay}</code>
              </pre>
            </div>

            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                {item.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-muted px-2 py-0.5">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 shrink-0 border-t border-border p-4">
        <button
          type="button"
          onClick={closeDetail}
          className="rounded-xl px-4 py-2 text-sm text-muted-foreground transition hover:bg-muted"
        >
          {t('common:action.close')}
        </button>
        <button
          type="button"
          onClick={() => applyInspiration(item)}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          <SparkleIcon className="h-4 w-4" />
          {t('detail.apply')}
        </button>
      </div>
    </div>
  )
}

function formatPrompt(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      // fallthrough: 不是合法 JSON，按原样
    }
  }
  return raw
}
