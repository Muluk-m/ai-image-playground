import ContextMenu from '../../../components/ContextMenu'
import { useTranslation } from '../../../i18n'
import type { ImageEl } from '../lib/canvasDoc'
import { RESIZE_RATIOS, submitCanvasResize } from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'

/** 比例图标：一个按该比例画出来的空框，比任何图形都直白。 */
function RatioGlyph({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(':').map(Number)
  const long = 18
  const width = w >= h ? long : (long * w) / h
  const height = h >= w ? long : (long * h) / w
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="rounded-[3px] border-[1.5px] border-current" style={{ width, height }} />
    </span>
  )
}

/**
 * 「调整尺寸」的比例菜单：挑一个比例，按那个画幅重出一张放在旁边。
 * 不是裁切——裁切在工具条上另有一个，那个一个像素都不重画。
 */
export default function CanvasResizeMenu({
  editor,
  image,
  x,
  y,
  onClose,
}: {
  editor: CanvasEditor
  image: ImageEl
  x: number
  y: number
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <p className="px-3 py-2 text-[11px] text-muted-foreground">{t('resize.hint')}</p>
      {RESIZE_RATIOS.map(({ ratio, key }) => (
        <button
          key={ratio}
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
          onClick={() => {
            void submitCanvasResize(editor, image, ratio)
            onClose()
          }}
        >
          <RatioGlyph ratio={ratio} />
          {/* key 里不能带冒号：i18next 会把它当命名空间分隔符，`resize.ratio.1:1` 会解析成
              命名空间 `resize.ratio.1`，界面上只剩一个「1」。 */}
          <span className="flex-1">{t(`resize.ratio.${key}`)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{ratio}</span>
        </button>
      ))}
    </ContextMenu>
  )
}
