import { type PointerEvent, useMemo, useRef } from 'react'
import { compactModelName, ModelLogo } from '../../../components/ModelIdentity'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { modelLabel } from '../../../lib/channels/publicChannels'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { inspirationFacetLabel } from '../lib/labels'
import { useInspirationStore } from '../store'

export default function InspirationDetail() {
  const detailItemId = useInspirationStore((s) => s.detailItemId)
  const detailFallback = useInspirationStore((s) => s.detailFallback)
  const closeDetail = useInspirationStore((s) => s.closeDetail)
  const items = useInspirationStore((s) => s.items)
  const showToast = useStore((s) => s.showToast)
  const { t } = useTranslation(['inspiration', 'common'])

  const item = useMemo(
    () =>
      items.find((i) => i.id === detailItemId) ??
      (detailFallback?.id === detailItemId ? detailFallback : null),
    [items, detailItemId, detailFallback],
  )

  const promptDisplay = useMemo(() => formatPrompt(item?.prompt ?? ''), [item?.prompt])
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  if (!item) return null
  const outputUrl = item.imageUrl ?? item.thumbnailUrl
  const reference = item.referenceImages?.[0]

  const onSwipeStart = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return
    swipe.current = { x: event.clientX, y: event.clientY }
  }
  const onSwipeEnd = (event: PointerEvent) => {
    const start = swipe.current
    swipe.current = null
    if (!start) return
    if ((scrollerRef.current?.scrollTop ?? 0) > 8) return
    const dy = event.clientY - start.y
    const dx = event.clientX - start.x
    if (dy > 72 && dy > Math.abs(dx)) closeDetail()
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      showToast(t('detail.promptCopied'), 'success')
    } catch {
      showToast(t('detail.copyFailed'), 'error')
    }
  }

  const categoryLabel = inspirationFacetLabel(item.category)
  const modelName = compactModelName(
    item.recommendedModel,
    modelLabel(item.recommendedModel, item.recommendedProvider),
  )

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-background animate-modal-in md:rounded-3xl md:bg-card"
      onPointerDown={onSwipeStart}
      onPointerUp={onSwipeEnd}
      onPointerCancel={() => {
        swipe.current = null
      }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 md:gap-2 md:p-5">
        <Button
          type="button"
          onClick={closeDetail}
          aria-label={t('detail.back')}
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
        >
          <Icon name="back" />
          <span className="max-md:sr-only">{t('detail.back')}</span>
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold md:hidden">{item.title}</h2>
        <div className="hidden min-w-0 truncate text-xs text-muted-foreground md:ml-auto md:block">
          {categoryLabel}
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto custom-scrollbar md:overflow-hidden"
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 md:overflow-y-auto md:p-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,1fr)] lg:gap-8">
          {/* 只在确实保存了输入图时才显示前后对比。 */}
          <div className="min-w-0">
            {reference ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <a
                    href={reference.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative flex h-36 items-center justify-center overflow-hidden bg-muted sm:h-60 sm:rounded-xl md:h-[min(62vh,560px)]"
                    aria-label={t('detail.openBefore')}
                  >
                    <img
                      src={reference.url}
                      alt={t('card.beforeAlt', { title: item.title })}
                      className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                      loading="lazy"
                    />
                    <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2.5 py-1 text-xs font-medium text-white">
                      {t('card.before')}
                    </span>
                  </a>
                  <a
                    href={outputUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative flex h-36 items-center justify-center overflow-hidden bg-muted sm:h-60 sm:rounded-xl md:h-[min(62vh,560px)]"
                    aria-label={t('detail.openAfter')}
                  >
                    <img
                      src={outputUrl}
                      alt={t('card.afterAlt', { title: item.title })}
                      className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                      loading="lazy"
                    />
                    <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2.5 py-1 text-xs font-medium text-white">
                      {t('card.after')}
                    </span>
                  </a>
                </div>
                {item.referenceImages && item.referenceImages.length > 1 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.referenceImages.slice(1).map((image, index) => (
                      <a
                        key={`${image.url}-${index}`}
                        href={image.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-lg border border-border/70 bg-card p-1.5 text-xs text-muted-foreground transition hover:border-primary/60"
                      >
                        <img
                          src={image.url}
                          alt=""
                          className="h-10 w-10 rounded object-cover"
                          loading="lazy"
                        />
                        <span className="max-w-28 truncate">{image.name}</span>
                      </a>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <a
                href={outputUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative flex h-[min(32vh,280px)] items-center justify-center overflow-hidden bg-muted md:h-auto md:min-h-72 md:rounded-2xl"
                title={t('detail.openOriginalHint')}
              >
                <img
                  src={outputUrl}
                  alt={item.title}
                  className="h-full max-h-[min(32vh,280px)] w-full object-contain transition-transform duration-200 group-hover:scale-[1.01] md:max-h-[min(70vh,680px)]"
                  loading="lazy"
                />
                <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 text-label-sm font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <Icon name="visible" size="xs" />
                  {t('detail.openOriginal')}
                </span>
              </a>
            )}
          </div>

          {/* 右：信息 */}
          <div className="flex min-w-0 flex-col gap-3 px-4 py-3 md:gap-4 md:px-0 md:py-0">
            <div className="hidden md:block">
              <h4 className="text-xl font-semibold tracking-tight text-foreground">{item.title}</h4>
              {item.description && (
                <p className="mt-1.5 text-sm text-muted-foreground">{item.description}</p>
              )}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                <span>{t('detail.promptLabel')}</span>
                <Button
                  type="button"
                  onClick={handleCopy}
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  aria-label={t('detail.copyPrompt')}
                >
                  <Icon name="copy" />
                  {t('common:action.copy')}
                </Button>
              </div>
              <pre
                data-selectable-text
                className="overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-card/80 p-3 text-sm leading-relaxed text-foreground md:max-h-[40vh] md:text-xs"
              >
                <code>{promptDisplay}</code>
              </pre>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              {reference && (
                <span className="rounded-md bg-primary/15 px-2 py-1 text-primary">
                  {t('card.imageEdit')}
                </span>
              )}
              <span className="rounded-md bg-primary/10 px-2 py-1 text-primary">
                {categoryLabel}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-muted-foreground">
                <ModelLogo model={item.recommendedModel} />
                <span>{modelName}</span>
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

            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-label-sm text-muted-foreground">
                {item.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-muted px-2 py-0.5">
                    #{inspirationFacetLabel(tag)}
                  </span>
                ))}
              </div>
            )}

            {item.sourceUrl && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {item.author ? `${item.author} · ` : ''}
                {t('detail.source')} <Icon name="external" size="xs" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-border p-3 md:justify-end md:p-4">
        <Button
          type="button"
          onClick={closeDetail}
          aria-label={t('detail.back')}
          variant="outline"
          size="sm"
          className="hidden md:inline-flex"
        >
          {t('common:action.close')}
        </Button>
        <Button
          type="button"
          onClick={() => applyInspiration(item)}
          size="sm"
          className="h-11 w-full md:h-8 md:w-auto"
        >
          <Icon name="generate" />
          {reference ? t('detail.applyWithReference') : t('detail.apply')}
        </Button>
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
