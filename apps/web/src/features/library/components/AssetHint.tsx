import { useEffect, useState } from 'react'
import { CloseIcon, LibraryIcon } from '../../../components/icons'
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
      <LibraryIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{t('hint.rightClickToSave')}</span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label={t('hint.close')}
        className="shrink-0 rounded p-0.5 transition hover:bg-primary/15"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
