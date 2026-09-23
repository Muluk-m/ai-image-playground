import type { InspirationWriteInput } from '@image-playground/shared'
import { Eye, ImageOff, Sparkles, Star } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { assetUrl, promptSlots } from './constants'

/**
 * 主站探索页那张卡的复刻：3:4 封面 + 左上分类 chip + 悬停才出的提示词浮层
 * （见 apps/web/src/features/inspiration/components/InspirationCard.tsx）。
 * 预览里把浮层常驻，运营要核的就是提示词有没有被封面盖住。
 */
export function SitePreview({
  draft,
  categoryName,
}: {
  draft: InspirationWriteInput
  categoryName: string
}) {
  const cover = assetUrl(draft.coverKey)
  const slots = draft.kind === 'template' ? promptSlots(draft.prompt) : []

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Eye className="size-3.5" />
        主站 /explore 看到的样子；发布后才会出现在清单里
      </p>
      <div className="rounded-2xl border bg-muted/30 p-5">
        <div className="mx-auto w-full max-w-[220px] overflow-hidden rounded-2xl border border-border/60 bg-card/40">
          <div className="relative aspect-[3/4] overflow-hidden bg-muted">
            {cover ? (
              <img src={cover} alt={draft.title} className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-muted-foreground">
                <ImageOff className="size-5" />
              </div>
            )}
            <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white backdrop-blur-sm">
              {categoryName}
            </span>
            {draft.featured ? (
              <span className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-warning/90 text-white">
                <Star className="size-3.5 fill-current" />
              </span>
            ) : null}
            <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/85 via-black/45 to-transparent">
              <p className="line-clamp-6 p-3 text-[11px] leading-relaxed text-white/95">
                {draft.prompt}
              </p>
            </div>
          </div>
          <div className="px-3 py-2.5">
            <div className="line-clamp-2 text-sm font-medium leading-snug">{draft.title}</div>
          </div>
        </div>
        <Button className="mx-auto mt-4 flex w-full max-w-[220px]" disabled>
          <Sparkles className="mr-2 size-4" />
          玩同款
        </Button>
      </div>

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">标签</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {draft.tags.length ? (
              draft.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground">没有标签</span>
            )}
          </dd>
        </div>
        {draft.kind === 'template' ? (
          <div>
            <dt className="text-xs text-muted-foreground">槽位（主站渲染成可填写 chip）</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {slots.length ? (
                slots.map((slot) => (
                  <Badge key={slot} variant="info">
                    {slot}
                  </Badge>
                ))
              ) : (
                <span className="text-destructive">提示词里一个 {'{槽位}'} 都没有，发布会被拒</span>
              )}
            </dd>
          </div>
        ) : null}
        {draft.kind === 'skill' ? (
          <div>
            <dt className="text-xs text-muted-foreground">玩同款时的起手式</dt>
            <dd className="mt-1">
              <code className="rounded bg-muted px-2 py-1 text-xs">
                /{draft.skillName ?? '未选技能'}
              </code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-muted-foreground">推荐参数</dt>
          <dd className="mt-1 text-muted-foreground">
            {draft.recommendedProvider} · {draft.recommendedModel || '未填模型'} ·{' '}
            {draft.params.size}
            {draft.params.quality ? ` · ${draft.params.quality}` : ''}
            {draft.params.n ? ` · ${draft.params.n} 张` : ''}
          </dd>
        </div>
      </dl>
    </div>
  )
}
