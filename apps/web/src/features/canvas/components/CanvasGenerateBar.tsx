import { useEffect, useRef, useState } from 'react'
import ParamControls from '../../../components/ParamControls'
import type { CanvasEditor } from '../lib/editor'
import { analyzeSelection, rasterizeEntry } from '../lib/rasterizeSelection'
import { submitFromCanvas } from '../lib/submitFromCanvas'

/** 预览缩略图的栅格化比例：低成本、48px 展示足够清晰。 */
const PREVIEW_SCALE = 0.25
/** 选区变化后延迟生成预览，避免拖选过程中频繁栅格化。 */
const PREVIEW_DEBOUNCE_MS = 250

interface SelectionInfo {
  imageCount: number
  annotated: boolean
  annotationText: string
  /** 条目构成签名：驱动预览重算（图/标注构成不变时不重复栅格化）。 */
  signature: string
}

const EMPTY_SELECTION: SelectionInfo = {
  imageCount: 0,
  annotated: false,
  annotationText: '',
  signature: '',
}

/** 订阅画布变更、维护当前选区分析结果（替代原 tldraw useValue 的响应式选择器）。 */
function useSelectionInfo(editor: CanvasEditor): SelectionInfo {
  const [info, setInfo] = useState(EMPTY_SELECTION)
  useEffect(() => {
    const update = () => {
      const plan = analyzeSelection(editor)
      const next = plan
        ? {
            imageCount: plan.entries.length,
            annotated: plan.annotated,
            annotationText: plan.annotationText,
            signature: plan.entries.map((e) => `${e.imageId}:${e.graphicIds.join('+')}`).join('|'),
          }
        : EMPTY_SELECTION
      // onChange 高频触发：内容不变时保留旧引用，跳过重渲染。
      setInfo((prev) =>
        prev.signature === next.signature &&
        prev.annotationText === next.annotationText &&
        prev.annotated === next.annotated &&
        prev.imageCount === next.imageCount
          ? prev
          : next,
      )
    }
    update()
    return editor.onChange(update)
  }, [editor])
  return info
}

/**
 * 画布底部浮动的生成输入条：统一文生图 / 多图迭代 / 标注迭代入口。
 * - 无选区 → 文生图；选中 N 张图 → 各自栅格化为独立参考图迭代
 * - 画在图上的标注（圈 / 箭头 / 文字）自动跟随被标注的图，无需精确框选
 * - 输入预览：每个将喂给模型的条目一张缩略图（含合成后的标注）+ 提取的文字标注，
 *   与提交共用同一套 analyzeSelection/rasterizeEntry，所见即所得
 * 发起即返回（无全局 busy 锁），任务由画布上的占位框反馈状态，支持并发。
 */
export default function CanvasGenerateBar({ editor }: { editor: CanvasEditor }) {
  const [prompt, setPrompt] = useState('')
  const [previews, setPreviews] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 与提交同一套选区分析：标注自动跟随被标注的图，提示与实际提交一致。
  const { imageCount, annotated, annotationText, signature } = useSelectionInfo(editor)

  // 输入预览缩略图：防抖 + 过期丢弃。
  useEffect(() => {
    if (!signature) {
      setPreviews([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const plan = analyzeSelection(editor)
      if (!plan || cancelled) return
      const thumbs = await Promise.all(
        plan.entries.map((entry) => rasterizeEntry(editor, entry, PREVIEW_SCALE)),
      )
      if (!cancelled) setPreviews(thumbs.filter((url): url is string => url !== null))
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [signature, editor])

  const canSubmit = prompt.trim().length > 0 || imageCount > 0

  const hint = annotated
    ? `已选中 ${imageCount} 张图片 + 手绘标注 · 将按标注迭代（输出不含标注线条）`
    : imageCount > 0
      ? `已选中 ${imageCount} 张图片 · 各自作为独立参考图迭代`
      : '未选中图片时为文生图；选中图片后可在图上手绘标注一起迭代'

  const run = () => {
    if (!canSubmit) return
    // 发起即返回：不 await，输入条立即恢复可交互（并发语义）。
    void submitFromCanvas(editor, prompt)
    setPrompt('')
    // 焦点还给画布：输入框聚焦时画布快捷键被 isTyping 守卫禁用，
    // 生成发出后用户的下一步通常是画布操作（选图 / 删除 / 复制粘贴）。
    textareaRef.current?.blur()
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-20 z-[400] flex justify-center px-4"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pointer-events-auto flex w-full max-w-2xl flex-col gap-2 rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur dark:border-white/10 dark:bg-gray-900/95">
        {/* 参数控制条：与工作台共用同一份全局 params/settings。数量 n>1 时 fan-out
            成 n 个并行任务，占位框水平排开各自出图（变体对比）。 */}
        <div className="flex flex-wrap items-center gap-2">
          <ParamControls showCount />
        </div>
        {/* 输入预览：模型将收到的每个参考图条目（含合成后的标注）+ 提取的文字标注。 */}
        {imageCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-2">
            {previews.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`输入 ${i + 1}`}
                className="h-12 w-12 rounded-md border border-gray-200 object-cover dark:border-white/10"
              />
            ))}
            {previews.length === 0 && (
              <span className="text-[11px] text-gray-400 dark:text-gray-500">预览生成中…</span>
            )}
            {annotationText && (
              <span className="max-w-[50%] truncate text-[11px] text-amber-600 dark:text-amber-400">
                文字标注 → 修改要求：{annotationText}
              </span>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col">
            <span className="px-2 pt-1 text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  run()
                } else if (e.key === 'Escape') {
                  // Esc 退出输入框、焦点还给画布（恢复画布快捷键）。
                  e.preventDefault()
                  e.currentTarget.blur()
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
