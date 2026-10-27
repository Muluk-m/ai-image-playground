import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useCanvasAssetsEntry } from '../lib/assetsEntry'

/** 顶栏积分左边的「资产」：只在画布页出现，打开整屏资产弹窗。 */
export default function CanvasAssetsEntryButton() {
  const { t } = useTranslation('canvas')
  const available = useCanvasAssetsEntry((s) => s.available)
  const open = useCanvasAssetsEntry((s) => s.open)
  const setOpen = useCanvasAssetsEntry((s) => s.setOpen)
  if (!available) return null
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
