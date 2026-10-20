import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { compactModelName, ModelLogo } from '../../../components/ModelIdentity'
import Badge from '../../../components/patterns/Badge'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { modelLabel } from '../../../lib/channels/publicChannels'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { applyInspiration, useInspirationAsReference } from '../lib/applyInspiration'
import {
  inspirationDetailIdFromHash,
  inspirationShareUrl,
  writeInspirationHash,
} from '../lib/hashRoute'
import { aspectText, inspirationImageUrl, rememberRatio } from '../lib/imageRatio'
import { inspirationFacetLabel } from '../lib/labels'
import { plainPrompt, promptHasArguments, promptSegments } from '../lib/promptArgs'
import { visibleInspirationItems } from '../lib/visibleItems'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'

function displayAuthor(author?: string | null): string | null {
  if (!author) return null
  const name = author.replace(/\s*[（(][^）)]*[）)]/g, '').trim()
  return name || null
}

function sizeLabel(size: string | undefined, auto: string): string {
  if (!size || size.trim().toLowerCase() === 'auto') return auto
  return size
}

function qualityLabel(
  quality: InspirationItem['params']['quality'],
  labels: Record<NonNullable<InspirationItem['params']['quality']>, string>,
): string | null {
  if (!quality) return null
  return labels[quality] ?? null
}

export default function InspirationDetail() {
  const detailItemId = useInspirationStore((s) => s.detailItemId)
  const detailFallback = useInspirationStore((s) => s.detailFallback)
  const closeDetail = useInspirationStore((s) => s.closeDetail)
  const showDetail = useInspirationStore((s) => s.showDetail)
  const items = useInspirationStore((s) => s.items)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const selectedGroup = useInspirationStore((s) => s.selectedGroup)
  const onlyImageEdits = useInspirationStore((s) => s.onlyImageEdits)
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)
  const togglePin = useStore((s) => s.toggleInspirationPin)
  const showToast = useStore((s) => s.showToast)
  const { t } = useTranslation(['inspiration', 'common'])
  const [imageSrc, setImageSrc] = useState('')
  const [, setMeasured] = useState(0)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const item = useMemo(
    () =>
      items.find((entry) => entry.id === detailItemId) ??
      (detailFallback?.id === detailItemId ? detailFallback : null),
    [items, detailItemId, detailFallback],
  )
  const ordered = useMemo(
    () =>
      visibleInspirationItems({
        items,
        provider: selectedProvider,
        category: selectedCategory,
        group: selectedGroup,
        onlyImageEdits,
        keyword: searchKeyword,
        pinnedIds,
      }),
    [
      items,
      selectedProvider,
      selectedCategory,
      selectedGroup,
      onlyImageEdits,
      searchKeyword,
      pinnedIds,
    ],
  )
  const index = item ? ordered.findIndex((entry) => entry.id === item.id) : -1
  const previous = index > 0 ? ordered[index - 1] : undefined
  const next = index >= 0 ? ordered[index + 1] : undefined
  const segments = useMemo(() => promptSegments(item?.prompt ?? ''), [item?.prompt])
  const outputUrl = item ? (item.imageUrl ?? item.thumbnailUrl) : ''

  useEffect(() => {
    if (!item) return
    writeInspirationHash(item.id)
    return () => {
      if (inspirationDetailIdFromHash() === item.id) writeInspirationHash(null)
    }
  }, [item])

  useEffect(() => {
    if (!item || item.referenceImages?.length) return
    const small = inspirationImageUrl(outputUrl, 480)
    const large = inspirationImageUrl(outputUrl, 1400)
    setImageSrc(small)
    if (small === large) return
    const image = new Image()
    image.onload = () => setImageSrc(large)
    image.src = large
  }, [item, outputUrl])

  useEffect(() => {
    for (const neighbor of [previous, next]) {
      if (!neighbor || neighbor.referenceImages?.length) continue
      const url = neighbor.imageUrl ?? neighbor.thumbnailUrl
      const image = new Image()
      image.src = inspirationImageUrl(url, 1400)
    }
  }, [previous, next])

  useEffect(() => {
    if (!item) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return
      }
      if (event.key === 'ArrowLeft' && previous) showDetail(previous.id)
      if (event.key === 'ArrowRight' && next) showDetail(next.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, previous, next, showDetail])

  if (!item) return null

  const reference = item.referenceImages?.[0]
  const pinned = pinnedIds.includes(item.id)
  const author = displayAuthor(item.author)
  const source = item.sourceUrl
  const category = inspirationFacetLabel(item.category)
  const modelName = compactModelName(
    item.recommendedModel,
    modelLabel(item.recommendedModel, item.recommendedProvider),
  )
  const aspect = aspectText(item)
  const quality = qualityLabel(item.params.quality, {
    high: t('detail.qualityHigh'),
    medium: t('detail.qualityMedium'),
    low: t('detail.qualityLow'),
    auto: t('detail.qualityAuto'),
  })
  const referenceCount = item.referenceImages?.length ?? 0

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

  const copyPrompt = async () => {
    try {
      await copyTextToClipboard(plainPrompt(item.prompt))
      showToast(t('detail.promptCopied'), 'success')
    } catch (error) {
      showToast(getClipboardFailureMessage(t('detail.copyFailed'), error), 'error')
    }
  }

  const copyLink = async () => {
    try {
      await copyTextToClipboard(inspirationShareUrl(item.id))
      showToast(t('detail.linkCopied'), 'success')
    } catch (error) {
      showToast(getClipboardFailureMessage(t('detail.copyFailed'), error), 'error')
    }
  }

  const remember = (image: HTMLImageElement) => {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return
    rememberRatio(item.id, image.naturalWidth, image.naturalHeight)
    setMeasured((value) => value + 1)
  }

  return (
    <Overlay onClose={closeDetail} role="none" label={item.title} className="max-md:p-0">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspiration-detail-title"
        data-testid="inspiration-detail"
        className="flex h-dvh w-full flex-col overflow-hidden bg-card outline-none md:grid md:h-[min(860px,calc(100dvh-4rem))] md:w-full md:max-w-7xl md:grid-cols-[minmax(0,1fr)_400px] md:rounded-3xl md:border md:border-border md:shadow-lg"
        onPointerDown={onSwipeStart}
        onPointerUp={onSwipeEnd}
        onPointerCancel={() => {
          swipe.current = null
        }}
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 md:hidden">
          <Button
            type="button"
            onClick={closeDetail}
            aria-label={t('detail.back')}
            variant="ghost"
            size="icon-sm"
            autoTooltip={false}
          >
            <Icon name="back" />
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-body-sm font-semibold">{item.title}</h2>
          <Button
            type="button"
            onClick={() => void copyLink()}
            aria-label={t('detail.copyLink')}
            variant="ghost"
            size="icon-sm"
            autoTooltip={false}
          >
            <Icon name="link" />
          </Button>
          <Button
            type="button"
            onClick={() => togglePin(item.id)}
            aria-pressed={pinned}
            aria-label={pinned ? t('card.unpin') : t('card.pin')}
            variant="ghost"
            size="icon-sm"
            autoTooltip={false}
          >
            <Icon name="favorite" filled={pinned} />
          </Button>
        </div>

        <div className="relative flex max-h-[58vh] min-h-0 shrink-0 items-center justify-center bg-black px-4 py-6 md:max-h-none md:h-auto md:px-16 md:py-8">
          {reference ? (
            <div className="grid h-full w-full grid-cols-2 gap-2">
              <figure className="relative flex min-h-0 items-center justify-center">
                <img
                  src={reference.url}
                  alt={t('card.beforeAlt', { title: item.title })}
                  className="max-h-full max-w-full rounded-lg object-contain"
                />
                <Badge tone="overlay" className="absolute bottom-2 left-2">
                  {t('card.before')}
                </Badge>
              </figure>
              <figure className="relative flex min-h-0 items-center justify-center">
                <img
                  src={outputUrl}
                  alt={t('card.afterAlt', { title: item.title })}
                  className="max-h-full max-w-full rounded-lg object-contain"
                  onLoad={(event) => remember(event.currentTarget)}
                />
                <Badge tone="overlay" className="absolute bottom-2 left-2">
                  {t('card.after')}
                </Badge>
              </figure>
            </div>
          ) : (
            <img
              src={imageSrc || inspirationImageUrl(outputUrl, 480)}
              alt={item.title}
              className="max-h-full max-w-full rounded-lg object-contain"
              onLoad={(event) => remember(event.currentTarget)}
            />
          )}
          <Button
            type="button"
            size="icon"
            variant="secondary"
            autoTooltip={false}
            aria-label={t('detail.prev')}
            disabled={!previous}
            className="absolute left-3 top-1/2 -translate-y-1/2 bg-black/55 text-white hover:bg-black/70"
            onClick={() => previous && showDetail(previous.id)}
          >
            <Icon name="chevronLeft" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            autoTooltip={false}
            aria-label={t('detail.next')}
            disabled={!next}
            className="absolute right-3 top-1/2 -translate-y-1/2 bg-black/55 text-white hover:bg-black/70"
            onClick={() => next && showDetail(next.id)}
          >
            <Icon name="chevronRight" />
          </Button>
          {index >= 0 ? (
            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-label-sm text-white">
              {index + 1} / {ordered.length}
            </span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-border md:border-l">
          <div className="hidden shrink-0 items-center gap-1 border-b border-border px-4 py-2 md:flex">
            <span className="inline-flex items-center gap-1 text-label-sm text-muted-foreground">
              <Icon name="chevronLeft" size="xs" />
              <Icon name="chevronRight" size="xs" />
              {t('detail.navHint')}
            </span>
            <span className="flex-1" />
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              autoTooltip={false}
              aria-label={t('detail.copyLink')}
              onClick={() => void copyLink()}
            >
              <Icon name="link" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              autoTooltip={false}
              aria-pressed={pinned}
              aria-label={pinned ? t('card.unpin') : t('card.pin')}
              onClick={() => togglePin(item.id)}
            >
              <Icon name="favorite" filled={pinned} />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              autoTooltip={false}
              aria-label={t('detail.close')}
              onClick={closeDetail}
            >
              <Icon name="close" />
            </Button>
          </div>
          <div ref={scrollerRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <h2
                id="inspiration-detail-title"
                className="font-display text-title font-semibold leading-snug"
              >
                {item.title}
              </h2>
              {author || source ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-label-sm text-muted-foreground">
                  {author ? <span>{author}</span> : null}
                  {author && source ? <span>·</span> : null}
                  {source ? (
                    <a
                      href={source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-primary"
                    >
                      {t('detail.source')}
                      <Icon name="external" size="xs" />
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
            {item.description ? (
              <p className="text-body-sm leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            ) : null}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-label-sm text-muted-foreground">
                  {t('detail.promptLabel')}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  autoTooltip={false}
                  aria-label={t('detail.copyPrompt')}
                  onClick={() => void copyPrompt()}
                >
                  <Icon name="copy" />
                  {t('detail.copy')}
                </Button>
              </div>
              <p className="whitespace-pre-wrap break-words rounded-xl bg-muted px-3 py-3 text-body-sm leading-relaxed text-foreground">
                {segments.map((segment, segmentIndex) =>
                  segment.type === 'arg' ? (
                    <mark
                      key={segmentIndex}
                      title={segment.name}
                      className="rounded bg-primary/15 px-0.5 text-primary"
                    >
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={segmentIndex}>{segment.text}</span>
                  ),
                )}
              </p>
              {promptHasArguments(item.prompt) ? (
                <p className="mt-1.5 text-label-sm text-muted-foreground">{t('detail.argHint')}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge>
                <ModelLogo model={item.recommendedModel} />
                {modelName}
              </Badge>
              {aspect ? (
                <Badge>
                  <Icon name="ratio" size="xs" />
                  {aspect}
                </Badge>
              ) : null}
              <Badge>{sizeLabel(item.params.size, t('detail.autoSize'))}</Badge>
              {quality ? (
                <Badge>
                  <Icon name="quality" size="xs" />
                  {quality}
                </Badge>
              ) : null}
              <Badge tone="primary">{category}</Badge>
              {referenceCount > 0 ? (
                <Badge tone="primary">{t('card.referenceCount', { count: referenceCount })}</Badge>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 gap-2 border-t border-border px-5 py-3">
            {item.kind === 'skill' ? null : (
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={() => void useInspirationAsReference(item)}
              >
                <Icon name="imageAdd" />
                {t('detail.useAsReference')}
              </Button>
            )}
            <Button type="button" className="min-w-0 flex-1" onClick={() => applyInspiration(item)}>
              <Icon name="generate" />
              {referenceCount > 0 ? t('detail.applyWithReference') : t('detail.apply')}
            </Button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
