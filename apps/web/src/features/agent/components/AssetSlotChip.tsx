import { ImagePlus, Upload } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import type { PromptAssetSlot } from '../../../lib/promptImageMentions'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { type AssetRecord, assetCoverImageId } from '../../library/types'
import type { CanvasImage } from '../lib/agentMentions'

/** 已填位上的一张图。 */
export interface AssetSlotImage {
  readonly src: string
  readonly name?: string
}

const CHIP =
  'mx-0.5 inline-flex max-w-56 items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-sm leading-5 transition-colors'
const EMPTY = 'border border-dashed border-primary/60 text-primary'

/** 素材库里最近用过的排前面，与 `@` 菜单同一个次序。 */
function recentFirst(assets: readonly AssetRecord[]): AssetRecord[] {
  return [...assets].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/**
 * 空位的外观：虚线框加位名。起手句列表里摆的就是它，点开之前两处长得一样。
 */
export function AssetSlotFace({ label, className = '' }: { label: string; className?: string }) {
  return (
    <span className={`${CHIP} ${EMPTY} ${className}`} data-asset-slot-face="">
      <ImagePlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** 填位面板里的一个来源：标题加一格格方形缩略图。素材库与画布是同一种栏。 */
function SlotSourceSection<T>({
  title,
  items,
  empty,
  itemKey,
  itemLabel,
  thumb,
  onPick,
}: {
  title: string
  items: readonly T[]
  /** 没有条目时的提示；不给就整栏不出现。 */
  empty?: string
  itemKey: (item: T) => string
  itemLabel: (item: T) => string
  thumb: (item: T) => ReactNode
  onPick: (item: T) => void
}) {
  if (items.length === 0 && !empty) return null
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid max-h-48 grid-cols-4 gap-1.5 overflow-y-auto">
          {items.map((item) => (
            <li key={itemKey(item)}>
              <Button
                type="button"
                variant="outline"
                aria-label={itemLabel(item)}
                title={itemLabel(item)}
                className="group block aspect-square h-auto w-full overflow-hidden p-0 hover:border-primary"
                onClick={() => onPick(item)}
              >
                {thumb(item)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 填位面板里的「画布」一栏：只在项目里挂（首页没有画布），画布上没有图时不出现。
 * 条目就是 `@` 菜单里的那份画布图。
 */
export function CanvasSlotSource({
  images,
  onPick,
}: {
  images: readonly CanvasImage[]
  onPick: (image: CanvasImage) => void
}) {
  const { t } = useTranslation('agent')
  return (
    <SlotSourceSection
      title={t('slot.canvas')}
      items={images}
      itemKey={(image) => image.imageId}
      itemLabel={(image) => image.label}
      thumb={(image) => (
        <MediaImage
          src={image.dataUrl}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      )}
      onPick={onPick}
    />
  )
}

/**
 * 素材位胶囊（CONTEXT「素材位」）：空着是虚线加位名，填好是缩略图。点开从素材库选一条、上传
 * 本地图（项目里还能选画布上的图），或者把图拖到胶囊上。首页对话输入框与项目 `AgentComposer` 都用这一个组件；图怎么进
 * 草稿归输入框，这里只把用户选的东西交回去。
 */
export default function AssetSlotChip({
  slot,
  images,
  onPickAsset,
  onUpload,
  onClear,
  extraSources,
}: {
  slot: PromptAssetSlot
  images: readonly AssetSlotImage[]
  onPickAsset: (asset: AssetRecord) => void
  onUpload: (files: File[]) => void
  onClear: () => void
  /** 别的来源（项目里的画布图）排在素材库与上传之后；拿到 `close` 选完自己关面板。 */
  extraSources?: (close: () => void) => ReactNode
}) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const assets = useLibraryStore((state) => state.assets)
  const close = () => setOpen(false)
  const take = (files: File[]) => {
    close()
    if (files.length > 0) onUpload(slot.multiple ? files : files.slice(0, 1))
  }
  const chipDrop = useImageDropZone(take)
  const panelDrop = useImageDropZone(take)
  const filled = images.length > 0
  const name = images.find((image) => image.name)?.name ?? slot.label

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-asset-slot-chip={slot.key}
          data-filled={filled ? '' : undefined}
          aria-label={t('slot.fillAria', { label: slot.label })}
          title={slot.label}
          className={`${CHIP} ${
            filled
              ? 'border border-border/70 bg-muted/80 font-medium text-foreground hover:bg-muted'
              : `${EMPTY} hover:bg-primary/10`
          } ${chipDrop.dragging ? 'ring-2 ring-primary' : ''}`}
          {...chipDrop.dropZoneProps}
        >
          {filled ? (
            <span className="flex -space-x-2">
              {images.slice(0, 3).map((image, index) => (
                <MediaImage
                  key={`${image.src}-${index}`}
                  src={image.src}
                  alt=""
                  draggable={false}
                  className="h-5 w-5 shrink-0 rounded object-cover ring-1 ring-background"
                />
              ))}
            </span>
          ) : (
            <ImagePlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{name}</span>
          {images.length > 1 && (
            <span className="text-xs text-muted-foreground">×{images.length}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" {...panelDrop.dropZoneProps}>
        <div className="flex flex-col gap-3" data-asset-slot-panel={slot.key}>
          <SlotSourceSection
            title={t('slot.library')}
            empty={t('slot.libraryEmpty')}
            items={recentFirst(assets)}
            itemKey={(asset) => asset.id}
            itemLabel={(asset) => asset.name}
            thumb={(asset) => <AssetThumb imageId={assetCoverImageId(asset)} alt="" />}
            onPick={(asset) => {
              close()
              onPickAsset(asset)
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple={slot.multiple}
            className="hidden"
            aria-label={t('slot.upload')}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])]
              event.currentTarget.value = ''
              take(files.filter((file) => file.type.startsWith('image/')))
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              {t('slot.upload')}
            </Button>
            {filled && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  close()
                  onClear()
                }}
              >
                {t('slot.clear')}
              </Button>
            )}
          </div>
          {extraSources?.(close)}
        </div>
      </PopoverContent>
    </Popover>
  )
}
