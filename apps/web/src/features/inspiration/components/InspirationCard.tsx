import type { MouseEvent } from 'react'
import { compactModelName } from '../../../components/ModelIdentity'
import Badge from '../../../components/patterns/Badge'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { modelLabel } from '../../../lib/channels/publicChannels'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { applyInspiration } from '../lib/applyInspiration'
import { inspirationImageUrl, ratioForItem, rememberRatio } from '../lib/imageRatio'
import { inspirationFacetLabel } from '../lib/labels'
import { plainPrompt } from '../lib/promptArgs'
import type { InspirationItem } from '../types'

interface Props {
  item: InspirationItem
  pinned: boolean
  onClick: () => void
  /** 瀑布流算好的图片高度。首页横滑不传，按实测比例撑开。 */
  imageHeight?: number
  onMeasured?: (width: number, height: number) => void
}

/**
 * 打开案例的是一张铺满卡片的真实按钮，工具条和收藏是它的兄弟节点。
 * 不能把按钮套进 role=button：嵌套交互控件是无效 HTML。
 */
export default function InspirationCard({ item, pinned, onClick, imageHeight, onMeasured }: Props) {
  const togglePin = useStore((s) => s.toggleInspirationPin)
  const showToast = useStore((s) => s.showToast)
  const { t } = useTranslation('inspiration')
  const hasReference = (item.referenceImages?.length ?? 0) > 0
  const category = inspirationFacetLabel(item.category)
  const modelName = compactModelName(
    item.recommendedModel,
    modelLabel(item.recommendedModel, item.recommendedProvider),
  )
  const ratio = ratioForItem(item)
  const imageStyle =
    imageHeight && imageHeight > 0 ? { height: imageHeight } : { aspectRatio: `1 / ${ratio}` }

  const stop = (event: MouseEvent) => {
    event.stopPropagation()
  }

  const handleApply = (event: MouseEvent<HTMLButtonElement>) => {
    stop(event)
    applyInspiration(item)
  }

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    stop(event)
    try {
      await copyTextToClipboard(plainPrompt(item.prompt))
      showToast(t('detail.promptCopied'), 'success')
    } catch (error) {
      showToast(getClipboardFailureMessage(t('detail.copyFailed'), error), 'error')
    }
  }

  const handlePin = (event: MouseEvent<HTMLButtonElement>) => {
    stop(event)
    togglePin(item.id)
  }

  return (
    <article className="group relative" data-testid="inspiration-card">
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        autoTooltip={false}
        aria-label={item.title}
        className="absolute inset-0 z-0 h-auto rounded-2xl p-0 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
      <div className="pointer-events-none relative z-[1]">
        <div className="relative overflow-hidden rounded-2xl bg-muted" style={imageStyle}>
          <img
            src={inspirationImageUrl(item.thumbnailUrl, 480)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03] group-focus-within:scale-[1.03]"
            onLoad={(event) => {
              const image = event.currentTarget
              if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return
              rememberRatio(item.id, image.naturalWidth, image.naturalHeight)
              onMeasured?.(image.naturalWidth, image.naturalHeight)
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 max-md:hidden" />
          {hasReference ? (
            <Badge tone="overlay" className="absolute left-2 top-2">
              {t('card.imageEdit')}
            </Badge>
          ) : null}
          {pinned ? (
            <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-md bg-black/55 text-primary md:group-hover:hidden md:group-focus-within:hidden">
              <Icon name="favorite" filled />
            </span>
          ) : null}
          <div className="pointer-events-auto absolute inset-x-2 bottom-2 hidden items-center gap-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
            <Button
              type="button"
              size="xs"
              autoTooltip={false}
              className="min-w-0 flex-1"
              onClick={handleApply}
            >
              <Icon name="generate" />
              {hasReference ? t('detail.applyWithReference') : t('detail.apply')}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="secondary"
              autoTooltip={false}
              aria-label={t('detail.copyPrompt')}
              onClick={handleCopy}
            >
              <Icon name="copy" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="secondary"
              autoTooltip={false}
              aria-pressed={pinned}
              aria-label={pinned ? t('card.unpin') : t('card.pin')}
              onClick={handlePin}
            >
              <Icon name="favorite" filled={pinned} />
            </Button>
          </div>
        </div>
        <div className="flex h-[46px] flex-col justify-center pt-2">
          <div className="truncate text-body-sm font-medium text-foreground transition-colors group-hover:text-primary">
            {item.title}
          </div>
          <div className="truncate text-label-sm text-muted-foreground">
            {category} · {modelName}
          </div>
        </div>
      </div>
    </article>
  )
}
