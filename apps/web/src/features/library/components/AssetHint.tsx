import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'

/**
 * 参考图缩略图上方的一次性提示。出现即记下，所以刷新后不再来；本次会话内
 * 关不关由本地 state 决定。
 */
export default function AssetHint() {
  const { t } = useTranslation('library')
  const [visible, setVisible] = useState(() => !useStore.getState().assetHintShown)

  useEffect(() => {
    if (visible) useStore.getState().markAssetHintShown()
  }, [visible])

  if (!visible) return null

  return (
    <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-primary/[0.08] px-2 py-1 text-xs text-primary">
      <Icon name="assets" size="xs" className="shrink-0" />
      <span className="flex-1">{t('hint.rightClickToSave')}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setVisible(false)}
        aria-label={t('hint.close')}
        className="shrink-0 text-primary hover:bg-primary/15 hover:text-primary"
      >
        <Icon name="close" size="xs" />
      </Button>
    </div>
  )
}
