import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { useTranslation } from '../../../i18n'
import { RESIZE_RATIOS, type ResizeRatio } from '../lib/canvasImageEdits'

/** 与单图同一组比例；选中比例只交给调用方去确认，不在这里直接提交。 */
export default function CanvasBatchResizeMenu({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number
  y: number
  onPick: (ratio: ResizeRatio) => void
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      {RESIZE_RATIOS.map(({ ratio, key }) => (
        <ContextMenuItem
          key={ratio}
          icon={<span className="w-6 text-center text-xs tabular-nums">{ratio}</span>}
          label={t(`resize.ratio.${key}`)}
          onClick={() => {
            onClose()
            onPick(ratio)
          }}
        />
      ))}
    </ContextMenu>
  )
}
