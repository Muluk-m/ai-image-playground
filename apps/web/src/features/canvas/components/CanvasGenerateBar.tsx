import { useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { submitFromCanvas } from '../lib/submitFromCanvas'

/**
 * 画布底部浮动的生成输入条：统一文生图 / 多图迭代入口。
 * 无选区 → 文生图；选中 N 张图 → 各自栅格化为独立参考图迭代。
 * 发起即返回（无全局 busy 锁），任务由画布上的占位框反馈状态，支持并发。
 * 渲染在 <Tldraw> children 内，因此可用 useEditor() 拿到编辑器实例。
 */
export default function CanvasGenerateBar() {
  const editor = useEditor()
  const [prompt, setPrompt] = useState('')

  const selectionCount = useValue(
    'imageSelectionCount',
    () => editor.getSelectedShapeIds().filter((id) => editor.getShape(id)?.type === 'image').length,
    [editor],
  )

  const canSubmit = prompt.trim().length > 0 || selectionCount > 0

  const run = () => {
    if (!canSubmit) return
    // 发起即返回：不 await，输入条立即恢复可交互（并发语义）。
    void submitFromCanvas(editor, prompt)
    setPrompt('')
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-4 z-[500] flex justify-center px-4"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pointer-events-auto flex w-full max-w-2xl items-end gap-2 rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur dark:border-white/10 dark:bg-gray-900/95">
        <div className="flex flex-1 flex-col">
          <span className="px-2 pt-1 text-[11px] text-gray-400 dark:text-gray-500">
            {selectionCount > 0
              ? `已选中 ${selectionCount} 张图片 · 各自作为独立参考图迭代`
              : '未选中图片时为文生图；选中图片后输入指令迭代'}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                run()
              }
            }}
            placeholder="描述想生成 / 想怎么改…（⌘/Ctrl + Enter 生成）"
            rows={1}
            className="max-h-32 min-h-[2.25rem] resize-none bg-transparent px-2 py-1.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-50"
          />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={!canSubmit}
          className="shrink-0 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          生成
        </button>
      </div>
    </div>
  )
}
