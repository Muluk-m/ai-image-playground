import { useState, useSyncExternalStore } from 'react'
import { duplicateSelection } from '../lib/canvasClipboard'
import type { CanvasDoc, Tool } from '../lib/canvasDoc'

const TOOLS: Array<{ tool: Tool; label: string; hotkey: string; icon: React.ReactNode }> = [
  {
    tool: 'select',
    label: '选择',
    hotkey: 'V',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 3l14 8-6.5 1.5L9 19 5 3z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'hand',
    label: '抓手',
    hotkey: 'H',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8 12V6.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V11m0-3.5a1.5 1.5 0 013 0V13c0 4-2.5 7-6.5 7S6 17 5 14.5l-1.3-3.2a1.4 1.4 0 012.4-1.3L8 12z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'pen',
    label: '画笔',
    hotkey: 'D',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 20c.5-3 1-4.5 2.5-6L17 3.5a2.1 2.1 0 013 3L9.5 17c-1.5 1.5-3 2-5.5 3z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'eraser',
    label: '橡皮',
    hotkey: 'E',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8.5 19L4 14.5a2 2 0 010-2.8L12.7 3a2 2 0 012.8 0L20 7.5a2 2 0 010 2.8L11.3 19H20M8.5 19H11.3M8.5 19l-2-2M7 9.5l7.5 7.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'arrow',
    label: '箭头',
    hotkey: 'A',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 19L18 6m0 0h-7m7 0v7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'text',
    label: '文字',
    hotkey: 'T',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 6V4h14v2M12 4v16m-3 0h6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
]

/** 快捷键速查（对齐线上版的右下角面板）。 */
const SHORTCUTS: Array<[string, string]> = [
  ['复制 / 粘贴', '⌘C ⌘V'],
  ['复制一份', '⌘D'],
  ['全选', '⌘A'],
  ['删除', '⌫'],
  ['撤销 / 重做', '⌘Z ⇧⌘Z'],
  ['选择 / 抓手', 'V H'],
  ['画笔 / 橡皮', 'D E'],
  ['箭头 / 文字', 'A T'],
  ['平移 / 缩放', '滚轮 · ⌘滚轮'],
  ['临时抓手', 'Space'],
  ['拖动时禁用吸附', '⌥拖动'],
  ['发起生成', '⌘⏎'],
]

function ToolButton({
  active,
  title,
  onClick,
  disabled,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'text-gray-300 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent'
      }`}
    >
      {children}
    </button>
  )
}

/** 底部居中工具条 + 左下角缩放控件 + 右下角快捷键速查。 */
export default function CanvasToolbar({ doc }: { doc: CanvasDoc }) {
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const { tool, selection, camera, viewport } = doc

  const zoomStep = (dir: 1 | -1) => {
    doc.zoomAt(viewport.width / 2, viewport.height / 2, camera.zoom * (dir === 1 ? 1.25 : 0.8))
  }

  return (
    <>
      {/* 工具条：底部居中 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[400] flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-white/10 bg-gray-900/95 p-1.5 shadow-lg backdrop-blur">
          {TOOLS.map(({ tool: t, label, hotkey, icon }) => (
            <ToolButton
              key={t}
              active={tool === t}
              title={`${label}（${hotkey}）`}
              onClick={() => doc.setTool(t)}
            >
              {icon}
            </ToolButton>
          ))}
          <div className="mx-1 h-6 w-px bg-white/10" />
          <ToolButton title="撤销（⌘Z）" disabled={!doc.canUndo} onClick={() => doc.undo()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M8 5L4 9l4 4M4 9h10a6 6 0 016 6v1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </ToolButton>
          <ToolButton title="重做（⌘⇧Z）" disabled={!doc.canRedo} onClick={() => doc.redo()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M16 5l4 4-4 4M20 9H10a6 6 0 00-6 6v1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </ToolButton>
          {selection.size > 0 && (
            <>
              <ToolButton title="复制一份（⌘D）" onClick={() => duplicateSelection(doc)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect
                    x="8"
                    y="8"
                    width="12"
                    height="12"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                  <path
                    d="M16 4H6a2 2 0 00-2 2v10"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </ToolButton>
              <ToolButton
                title="删除所选（Del）"
                onClick={() => doc.deleteElements([...doc.selection])}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 7h14M9 7V5h6v2m-8 0l1 13h8l1-13"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </ToolButton>
            </>
          )}
        </div>
      </div>
      {/* 缩放控件：左下角 */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-[400]">
        <div className="pointer-events-auto flex items-center rounded-xl border border-white/10 bg-gray-900/95 shadow-lg backdrop-blur">
          <button
            type="button"
            title="缩小"
            onClick={() => zoomStep(-1)}
            className="px-3 py-2 text-gray-300 hover:bg-white/10"
          >
            −
          </button>
          <button
            type="button"
            title="重置为 100%"
            onClick={() => doc.zoomAt(viewport.width / 2, viewport.height / 2, 1)}
            className="min-w-14 px-1 py-2 text-center text-xs text-gray-300 tabular-nums hover:bg-white/10"
          >
            {Math.round(camera.zoom * 100)}%
          </button>
          <button
            type="button"
            title="放大"
            onClick={() => zoomStep(1)}
            className="px-3 py-2 text-gray-300 hover:bg-white/10"
          >
            ＋
          </button>
        </div>
      </div>
      {/* 快捷键速查：右下角 */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-[400] flex flex-col items-end gap-2">
        {showShortcuts && (
          <div className="pointer-events-auto w-56 rounded-2xl border border-white/10 bg-gray-900/95 p-3 shadow-lg backdrop-blur">
            {SHORTCUTS.map(([label, keys]) => (
              <div
                key={label}
                className="flex items-center justify-between py-1 text-xs text-gray-300"
              >
                <span>{label}</span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-gray-400">
                  {keys}
                </span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          title="快捷键"
          onClick={() => setShowShortcuts((v) => !v)}
          className={`pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-white/10 shadow-lg backdrop-blur transition-colors ${
            showShortcuts
              ? 'bg-blue-600 text-white'
              : 'bg-gray-900/95 text-gray-300 hover:bg-white/10'
          }`}
        >
          ?
        </button>
      </div>
    </>
  )
}
