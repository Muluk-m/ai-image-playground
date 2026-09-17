import { useState } from 'react'
import { useTranslation } from '../../../i18n'

/** macOS 显示 ⌘ 符号，其余平台显示 Ctrl。 */
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '')
const MOD = IS_MAC ? '⌘' : 'Ctrl'

/** 用户手动收起后记住选择，下次不再默认展开（引导只需一次）。 */
const COLLAPSED_STORAGE_KEY = 'canvas-shortcuts-collapsed'

/**
 * 快捷键引导：默认收起，按需查看，可一键收起（收起后记住，之后默认只剩一颗
 * 28px 圆形图标钮）。桌面端专属（移动端无键盘）。
 * 定位由 CanvasMode 的右下角控件栈负责——它和小地图共用一列，自己不占绝对定位，
 * 免得两个都往角上贴、糊在一起。
 */
export default function CanvasShortcutsHint() {
  const { t } = useTranslation('canvas')
  const [open, setOpen] = useState(() => localStorage.getItem(COLLAPSED_STORAGE_KEY) === '0')

  /** 精选最常用的一屏速查，保持面板小巧。 */
  const shortcutRows: Array<{ label: string; keys: string[] }> = [
    { label: t('shortcuts.row.copyPaste'), keys: [`${MOD}C`, `${MOD}V`] },
    { label: t('shortcuts.row.delete'), keys: ['⌫', `${MOD}⌫`] },
    { label: t('shortcuts.row.selectAll'), keys: [`${MOD}A`, `⇧${t('shortcuts.key.click')}`] },
    { label: t('shortcuts.row.duplicate'), keys: [`${MOD}D`] },
    { label: t('shortcuts.row.undoRedo'), keys: [`${MOD}Z`, `⇧${MOD}Z`] },
    { label: t('shortcuts.row.selectHand'), keys: ['V', 'H'] },
    { label: t('shortcuts.row.penEraser'), keys: ['D', 'E'] },
    { label: t('shortcuts.row.arrowText'), keys: ['A', 'T'] },
    { label: t('shortcuts.row.zoomPan'), keys: [`${MOD}${t('shortcuts.key.wheel')}`, 'Space'] },
    { label: t('shortcuts.row.freeDrag'), keys: [`⌥${t('shortcuts.key.drag')}`] },
    { label: t('shortcuts.row.submitBack'), keys: [`${MOD}⏎`, 'Esc'] },
  ]

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, v ? '1' : '0')
      return !v
    })
  }

  return (
    <div className="flex flex-col items-end gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
      {open && (
        <div className="pointer-events-auto w-52 rounded-xl border border-border bg-sidebar px-2.5 py-2 shadow-xl backdrop-blur">
          {shortcutRows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-2 py-[3px]">
              <span className="text-[11px] text-foreground">{row.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] leading-none text-foreground"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border shadow-lg backdrop-blur transition-colors ${
          open
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border bg-sidebar text-muted-foreground hover:text-foreground'
        }`}
        title={open ? t('shortcuts.collapse') : t('shortcuts.expand')}
        aria-label={t('shortcuts.title')}
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 7a1 1 0 011-1h14a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V7z M7 10h.01M11 10h.01M15 10h.01M7 14h10"
          />
        </svg>
      </button>
    </div>
  )
}
