import { useState } from 'react'

/** macOS 显示 ⌘ 符号，其余平台显示 Ctrl。 */
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '')
const MOD = IS_MAC ? '⌘' : 'Ctrl'

/** 精选最常用的一屏速查，保持面板小巧；完整快捷键交给 tldraw 菜单。 */
const SHORTCUT_ROWS: Array<{ label: string; keys: string[] }> = [
  { label: '复制 / 粘贴', keys: [`${MOD}C`, `${MOD}V`] },
  { label: '删除', keys: ['⌫', `${MOD}⌫`] },
  { label: '全选 / 加选', keys: [`${MOD}A`, '⇧点击'] },
  { label: '复制一份', keys: [`${MOD}D`] },
  { label: '撤销 / 重做', keys: [`${MOD}Z`, `⇧${MOD}Z`] },
  { label: '选择 / 抓手', keys: ['V', 'H'] },
  { label: '画笔 / 橡皮', keys: ['D', 'E'] },
  { label: '缩放', keys: [`${MOD}滚轮`] },
  { label: '发起生成 / 回画布', keys: [`${MOD}⏎`, 'Esc'] },
]

/** 用户手动收起后记住选择，下次不再默认展开（引导只需一次）。 */
const COLLAPSED_STORAGE_KEY = 'canvas-shortcuts-collapsed'

/**
 * 画布右下角的快捷键引导：**默认展开**做新手引导，可一键收起（收起后记住，
 * 之后默认只剩一颗 28px 圆形图标钮）。定位避开 tldraw 右下 watermark；
 * 桌面端专属（移动端无键盘）。
 */
export default function CanvasShortcutsHint() {
  const [open, setOpen] = useState(() => localStorage.getItem(COLLAPSED_STORAGE_KEY) !== '1')

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, v ? '1' : '0')
      return !v
    })
  }

  return (
    <div
      className="pointer-events-none absolute bottom-14 right-3 z-[400] hidden flex-col items-end gap-1.5 sm:flex"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {open && (
        <div className="pointer-events-auto w-52 rounded-xl border border-white/10 bg-gray-900/95 px-2.5 py-2 shadow-xl backdrop-blur">
          {SHORTCUT_ROWS.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-2 py-[3px]">
              <span className="text-[11px] text-gray-300">{row.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border border-white/10 bg-white/[0.06] px-1 py-px font-mono text-[10px] leading-none text-gray-300"
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
            ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
            : 'border-white/10 bg-gray-900/90 text-gray-500 hover:text-gray-200'
        }`}
        title={open ? '收起快捷键' : '查看快捷键'}
        aria-label="快捷键速查"
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
