import { useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import ParamControls from '../../../components/ParamControls'
import { submitFromCanvas } from '../lib/submitFromCanvas'

/**
 * 画布底部浮动的生成输入条：统一文生图 / 多图迭代 / 标注迭代入口。
 * - 无选区 → 文生图；选中 N 张图 → 各自栅格化为独立参考图迭代
 * - 选区含手绘标注（画笔 / 箭头 / 文字等）→ 图片连同标注合成一张，按标注迭代
 * 发起即返回（无全局 busy 锁），任务由画布上的占位框反馈状态，支持并发。
 *
 * 定位在 tldraw 默认工具栏**上方**（bottom-24），不遮挡底部工具栏——用户可正常在
 * 选择 / 画笔 / 橡皮等工具间切换（画笔画完按 Esc 或点工具栏箭头即回到选择工具）。
 * 渲染在 <Tldraw> children 内，因此可用 useEditor() 拿到编辑器实例。
 */
export default function CanvasGenerateBar() {
  const editor = useEditor()
  const [prompt, setPrompt] = useState('')

  const imageCount = useValue(
    'canvasImageSelCount',
    () => editor.getSelectedShapeIds().filter((id) => editor.getShape(id)?.type === 'image').length,
    [editor],
  )
  const hasAnnotations = useValue('canvasHasAnnotations', () => {
    const ids = editor.getSelectedShapeIds()
    const imgs = ids.filter((id) => editor.getShape(id)?.type === 'image').length
    return ids.length > imgs && imgs > 0
  }, [editor])

  const canSubmit = prompt.trim().length > 0 || imageCount > 0

  const hint = hasAnnotations
    ? `已选中 ${imageCount} 张图片 + 手绘标注 · 将按标注迭代（输出不含标注线条）`
    : imageCount > 0
      ? `已选中 ${imageCount} 张图片 · 各自作为独立参考图迭代`
      : '未选中图片时为文生图；选中图片后可在图上手绘标注一起迭代'

  const run = () => {
    if (!canSubmit) return
    // 发起即返回：不 await，输入条立即恢复可交互（并发语义）。
    void submitFromCanvas(editor, prompt)
    setPrompt('')
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-24 z-[400] flex justify-center px-4"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pointer-events-auto flex w-full max-w-2xl flex-col gap-2 rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur dark:border-white/10 dark:bg-gray-900/95">
        {/* 参数控制条：与工作台共用同一份全局 params/settings，创作模式下也能选模型 / 尺寸 / 质量等。 */}
        <div className="flex flex-wrap items-center gap-2">
          <ParamControls />
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col">
            <span className="px-2 pt-1 text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>
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
    </div>
  )
}
