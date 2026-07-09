import { useSyncExternalStore } from 'react'
import type { ArrowEl, CanvasDoc, FreedrawEl, TextEl } from '../lib/canvasDoc'
import { measureText } from '../lib/konvaShapes'

/** 标注色板（暗色画布可辨识的 12 色，布局对齐 tldraw 风格面板）。 */
const COLORS = [
  '#f8fafc',
  '#9ca3af',
  '#e879f9',
  '#a78bfa',
  '#3b82f6',
  '#38bdf8',
  '#facc15',
  '#f97316',
  '#10b981',
  '#4ade80',
  '#f472b6',
  '#ef4444',
]

/** 线宽 / 字号档位（页面单位）。 */
const STROKE_SIZES = [
  { label: 'S', value: 2.5 },
  { label: 'M', value: 4 },
  { label: 'L', value: 7 },
  { label: 'XL', value: 12 },
]
const TEXT_SIZES = [
  { label: 'S', value: 18 },
  { label: 'M', value: 28 },
  { label: 'L', value: 42 },
  { label: 'XL', value: 64 },
]

function SizeChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 flex-1 rounded-lg text-xs font-medium transition-colors ${
        active ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * 右上样式面板（对齐线上 tldraw 的样式面板位置）：颜色 + 线宽 + 字号。
 * 展示时机：绘制类工具激活，或选中了可调样式的元素。
 * 点选样式 = 设为默认（后续新建沿用）+ 就地套用到当前选中元素（入 undo 历史）。
 */
export default function StylePanel({ doc }: { doc: CanvasDoc }) {
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const { tool, selection } = doc

  const selected = [...selection].map((id) => doc.getElement(id))
  const strokeSelected = selected.filter(
    (el): el is FreedrawEl | ArrowEl => el?.type === 'freedraw' || el?.type === 'arrow',
  )
  const textSelected = selected.filter((el): el is TextEl => el?.type === 'text')
  const colorable = [...strokeSelected, ...textSelected]

  const drawToolActive = tool === 'pen' || tool === 'arrow' || tool === 'text'
  const showStroke = tool === 'pen' || tool === 'arrow' || strokeSelected.length > 0
  const showText = tool === 'text' || textSelected.length > 0
  if (!drawToolActive && colorable.length === 0) return null

  const applyColor = (color: string) => {
    doc.setPenColor(color)
    if (colorable.length === 0) return
    doc.updateElements(
      colorable.map((el) => ({
        id: el.id,
        patch: el.type === 'text' ? { fill: color } : { stroke: color },
      })),
      { history: true },
    )
  }

  const applyStrokeWidth = (width: number) => {
    doc.setPenWidth(width)
    if (strokeSelected.length === 0) return
    doc.updateElements(
      strokeSelected.map((el) => ({ id: el.id, patch: { strokeWidth: width } })),
      { history: true },
    )
  }

  const applyTextSize = (size: number) => {
    doc.setTextFontSize(size)
    if (textSelected.length === 0) return
    doc.updateElements(
      textSelected.map((el) => ({
        id: el.id,
        patch: { fontSize: size, ...measureText(el.text, size) },
      })),
      { history: true },
    )
  }

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-[400]">
      <div className="pointer-events-auto w-40 rounded-2xl border border-white/10 bg-gray-900/95 p-2.5 shadow-lg backdrop-blur">
        <div className="grid grid-cols-4 gap-1.5">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={`标注颜色 ${color}`}
              aria-label={`标注颜色 ${color}`}
              onClick={() => applyColor(color)}
              className={`mx-auto h-6 w-6 rounded-full border-2 transition-transform ${
                doc.penColor === color ? 'scale-110 border-white' : 'border-transparent'
              }`}
              style={{ background: color }}
            />
          ))}
        </div>
        {showStroke && (
          <div className="mt-2.5 flex gap-1">
            {STROKE_SIZES.map((s) => (
              <SizeChip
                key={s.label}
                label={s.label}
                active={doc.penWidth === s.value}
                onClick={() => applyStrokeWidth(s.value)}
              />
            ))}
          </div>
        )}
        {showText && (
          <div className="mt-1.5 flex gap-1">
            {TEXT_SIZES.map((s) => (
              <SizeChip
                key={s.label}
                label={`Aa ${s.label}`}
                active={doc.textFontSize === s.value}
                onClick={() => applyTextSize(s.value)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
