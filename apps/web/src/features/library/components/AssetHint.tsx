import { useEffect, useState } from 'react'
import { CloseIcon, LibraryIcon } from '../../../components/icons'
import { useStore } from '../../../store'

/**
 * 参考图缩略图上方的一次性提示。出现即记下，所以刷新后不再来；本次会话内
 * 关不关由本地 state 决定。
 */
export default function AssetHint() {
  const [visible, setVisible] = useState(() => !useStore.getState().assetHintShown)

  useEffect(() => {
    if (visible) useStore.getState().markAssetHintShown()
  }, [visible])

  if (!visible) return null

  return (
    <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-blue-500/[0.08] px-2 py-1 text-xs text-blue-700 dark:bg-blue-500/[0.12] dark:text-blue-300">
      <LibraryIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">右键可存为素材</span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="关闭提示"
        className="shrink-0 rounded p-0.5 transition hover:bg-blue-500/15"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
