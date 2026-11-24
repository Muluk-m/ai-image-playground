import { useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { getSelectedImageMentionLabel } from '../../lib/promptImageMentions'
import { cn } from '../../lib/utils'
import type { InputImage } from '../../types'
import { paper } from '../assistant-ui/elements/surfaces'
import MediaImage from '../MediaImage'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

type ExampleId = 'replaceProduct' | 'whiteBg'

/**
 * 批量生图底栏的轻量「查看示例 ›」浮层：
 * - 「使用示例」：可视化展示遍历原图 + 共用参考 → 逐张出图的配对关系，支持一键填入示范提示词；
 * - 「当前拆解」：用用户当前真实上传的两区图片动态拼出前 3 条将发出的任务拆解。
 */
export function BatchExamplesPopover({
  loopImages,
  sharedImages,
  mergeLimit,
  taskCount,
  slotVariants = 1,
  totalCredits,
  onApplyPrompt,
}: {
  loopImages: readonly InputImage[]
  sharedImages: readonly InputImage[]
  mergeLimit: number
  taskCount?: number
  slotVariants?: number
  totalCredits?: number
  onApplyPrompt: (prompt: string) => void
}) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'gallery' | 'live'>('gallery')
  const [exampleId, setExampleId] = useState<ExampleId>('replaceProduct')
  const suppressFocusReturnRef = useRef(false)

  const loopCount = loopImages.length
  const sharedCount = sharedImages.length
  const variants = Math.max(1, slotVariants)
  const effectiveTaskCount = taskCount ?? loopCount * variants
  const needsSharedForExample = exampleId === 'replaceProduct' && sharedCount === 0

  // 按与 submitPrepared 相同的展开顺序（先原图、再槽位变体）构建前 3 条任务预览。
  const previewRows: { key: string; taskNo: number; loopNo: number; image: InputImage }[] = []
  for (let loopIdx = 0; loopIdx < loopImages.length && previewRows.length < 3; loopIdx += 1) {
    const img = loopImages[loopIdx]!
    for (let variantIdx = 0; variantIdx < variants && previewRows.length < 3; variantIdx += 1) {
      previewRows.push({
        key: `${img.id}-${variantIdx}`,
        taskNo: loopIdx * variants + variantIdx + 1,
        loopNo: loopIdx + 1,
        image: img,
      })
    }
  }

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setTab(loopCount > 0 ? 'live' : 'gallery')
    }
  }

  const handleApply = (id: ExampleId) => {
    if (id === 'replaceProduct' && sharedCount === 0) return
    const current = getSelectedImageMentionLabel(0)
    const ref1 = getSelectedImageMentionLabel(1)
    const template =
      id === 'replaceProduct'
        ? t('batch.examples.replaceProductPrompt', {
            current,
            ref: ref1,
          })
        : t('batch.examples.whiteBgPrompt', { current })
    suppressFocusReturnRef.current = true
    onApplyPrompt(template)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'creation-batch-examples-trigger gap-1 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground',
            open && 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary',
          )}
        >
          <span>{t('batch.examples.trigger')}</span>
          <Icon name="chevronRight" size="xs" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        onCloseAutoFocus={(event) => {
          if (suppressFocusReturnRef.current) {
            suppressFocusReturnRef.current = false
            event.preventDefault()
          }
        }}
        className={cn(
          paper,
          'w-96 max-w-[calc(100vw-2rem)] rounded-2xl p-4 shadow-popover space-y-3',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1 rounded-full bg-secondary p-0.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={tab === 'gallery'}
              className={cn(
                'rounded-full px-2.5 text-xs',
                tab === 'gallery'
                  ? 'bg-primary/15 font-medium text-primary hover:bg-primary/15 hover:text-primary'
                  : 'text-muted-foreground',
              )}
              onClick={() => setTab('gallery')}
            >
              {t('batch.examples.tabGallery')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={tab === 'live'}
              className={cn(
                'rounded-full px-2.5 text-xs tabular-nums',
                tab === 'live'
                  ? 'bg-primary/15 font-medium text-primary hover:bg-primary/15 hover:text-primary'
                  : 'text-muted-foreground',
              )}
              onClick={() => setTab('live')}
            >
              {effectiveTaskCount > 0
                ? t('batch.examples.tabLiveCount', { count: effectiveTaskCount })
                : t('batch.examples.tabLive')}
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('settings.close')}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" />
          </Button>
        </div>

        {tab === 'gallery' ? (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              {(['replaceProduct', 'whiteBg'] as const).map((id) => (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-pressed={exampleId === id}
                  className={cn(
                    'rounded-full px-2.5 text-xs',
                    exampleId === id
                      ? 'bg-primary/15 font-medium text-primary hover:bg-primary/15 hover:text-primary'
                      : 'text-muted-foreground',
                  )}
                  onClick={() => setExampleId(id)}
                >
                  {id === 'replaceProduct'
                    ? t('batch.examples.replaceProductTitle')
                    : t('batch.examples.whiteBgTitle')}
                </Button>
              ))}
            </div>

            <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-foreground">
              <span className="mt-0.5 shrink-0 text-primary">
                <Icon name="generate" size="xs" />
              </span>
              <span>
                {exampleId === 'replaceProduct'
                  ? t('batch.examples.replaceProductSummary')
                  : t('batch.examples.whiteBgSummary')}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-2.5 text-label-sm">
              <div className="flex items-center gap-2">
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-1">
                    <span className="grid h-10 w-8 place-items-center rounded-md border border-border bg-secondary text-muted-foreground">
                      <Icon name="image" size="xs" />
                    </span>
                    <span className="grid h-10 w-8 place-items-center rounded-md border border-border bg-secondary text-muted-foreground">
                      <Icon name="image" size="xs" />
                    </span>
                  </div>
                  <span className="text-muted-foreground">{t('batch.examples.loopLabel')}</span>
                </div>
                {exampleId === 'replaceProduct' && (
                  <>
                    <span className="pb-4 text-muted-foreground">
                      <Icon name="add" size="xs" />
                    </span>
                    <div className="flex flex-col items-center gap-1">
                      <span className="grid h-10 w-8 place-items-center rounded-md border border-border bg-card text-foreground">
                        <Icon name="link" size="xs" />
                      </span>
                      <span className="text-muted-foreground">
                        {t('batch.examples.sharedLabel')}
                      </span>
                    </div>
                  </>
                )}
              </div>

              <span className="mb-4 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
                <Icon name="chevronRight" size="xs" />
              </span>

              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-1">
                  <span className="grid h-10 w-8 place-items-center rounded-md border border-primary/40 bg-primary/15 text-primary">
                    <Icon name="generate" size="xs" />
                  </span>
                  <span className="grid h-10 w-8 place-items-center rounded-md border border-primary/40 bg-primary/15 text-primary">
                    <Icon name="generate" size="xs" />
                  </span>
                </div>
                <span className="text-primary">{t('batch.examples.outputLabel')}</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2.5">
              <span className="text-label-sm text-muted-foreground">
                {needsSharedForExample
                  ? t('batch.examples.needSharedRef')
                  : t('batch.examples.dragTip')}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={needsSharedForExample}
                className="shrink-0 rounded-lg bg-primary/15 px-2.5 text-xs font-medium text-primary hover:bg-primary/20 hover:text-primary"
                onClick={() => handleApply(exampleId)}
              >
                {t('batch.examples.fillPrompt')}
              </Button>
            </div>
          </div>
        ) : loopCount === 0 ? (
          <div className="py-5 text-center text-xs text-muted-foreground">
            {t('batch.examples.liveEmpty')}
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2 text-label-sm text-muted-foreground">
              <span>
                {totalCredits !== undefined
                  ? t('batch.examples.liveSummaryCredits', {
                      count: effectiveTaskCount,
                      credits: totalCredits.toLocaleString(),
                    })
                  : t('batch.examples.liveSummary', { count: effectiveTaskCount })}
              </span>
              <span className="font-mono tabular-nums">
                {1 + sharedCount}/{mergeLimit}
              </span>
            </div>
            <div className="space-y-1.5">
              {previewRows.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/50 px-2.5 py-1.5 text-label-sm"
                >
                  <span className="w-6 shrink-0 font-mono tabular-nums text-muted-foreground">
                    #{row.taskNo}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <MediaImage
                      src={row.image.dataUrl}
                      alt=""
                      className="h-6 w-5 shrink-0 rounded-sm object-cover"
                    />
                    <span>{t('batch.examples.liveLoopItem', { n: row.loopNo })}</span>
                  </span>
                  {sharedCount > 0 && sharedImages[0] && (
                    <>
                      <span className="text-muted-foreground">
                        <Icon name="add" size="xs" />
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <MediaImage
                          src={sharedImages[0].dataUrl}
                          alt=""
                          className="h-6 w-5 shrink-0 rounded-sm object-cover"
                        />
                        <span>
                          {sharedCount > 1
                            ? t('batch.examples.liveSharedMany', { count: sharedCount })
                            : t('batch.sharedShortBadge', { n: 1 })}
                        </span>
                      </span>
                    </>
                  )}
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                    <Icon name="chevronRight" size="xs" />
                    <span>{t('batch.examples.liveOutputItem', { n: row.taskNo })}</span>
                  </span>
                </div>
              ))}
              {effectiveTaskCount > previewRows.length && (
                <div className="pl-1 text-label-sm text-muted-foreground">
                  {t('batch.examples.liveMore', { count: effectiveTaskCount - previewRows.length })}
                </div>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
