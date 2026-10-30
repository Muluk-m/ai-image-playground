import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useCanvasAssetsEntry } from '../lib/assetsEntry'
import { useCanvasViewShown } from '../lib/canvasView'

/** 顶栏积分左边的「资产」：只在画布页出现，打开整屏资产弹窗。 */
export default function CanvasAssetsEntryButton() {
  const { t } = useTranslation('canvas')
  const available = useCanvasAssetsEntry((s) => s.available)
  const open = useCanvasAssetsEntry((s) => s.open)
  const setOpen = useCanvasAssetsEntry((s) => s.setOpen)
  // 对话视图里画布只是藏着、仍算挂载；那边已有自己的「资产库」，这里再露一个就重复了。
  const canvasShown = useCanvasViewShown()
  if (!available || !canvasShown) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="studio-canvas-assets-entry"
      aria-haspopup="dialog"
      aria-pressed={open}
      onClick={() => setOpen(!open)}
    >
      <Icon name="image" />
      <span>{t('assetsPanel.title')}</span>
    </Button>
  )
}
