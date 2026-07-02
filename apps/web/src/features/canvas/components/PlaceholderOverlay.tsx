import { useEffect, useState } from 'react'
import { type CanvasEditor, type PlaceholderView, STATUS_ACCENT } from '../lib/editor'
import { retryCanvasTask } from '../lib/submitFromCanvas'

/**
 * 占位框内容浮层：虚线边框由画布上的 rectangle 元素本体绘制（跟随选择 / 导出语义），
 * spinner / 错误文案 / 重试按钮走 DOM 浮层——Excalidraw 的 embeddable 自定义渲染在元素
 * 未「激活」前不接收指针事件（重试会变两步点击），浮层方案指针行为完全自控：
 * 容器保持指针穿透（悬停时滚轮缩放 / 拖拽平移不被吞掉），仅重试按钮开启指针事件。
 * 位置随画布 scroll / zoom 实时换算，内容用 scale(zoom) 与页面坐标系同步缩放。
 */

interface OverlayState {
  placeholders: PlaceholderView[]
  scrollX: number
  scrollY: number
  zoom: number
}

function snapshot(editor: CanvasEditor): OverlayState {
  const s = editor.api.getAppState()
  return {
    placeholders: editor.getPlaceholders(),
    scrollX: s.scrollX,
    scrollY: s.scrollY,
    zoom: s.zoom.value,
  }
}

/** 渲染相关字段的浅签名：onChange 高频触发，无视觉变化时跳过 setState 重渲染。 */
function renderSignature(state: OverlayState): string {
  const items = state.placeholders
    .map((p) => `${p.id}:${p.x}:${p.y}:${p.w}:${p.h}:${p.status}:${p.message}`)
    .join('|')
  return `${state.scrollX}:${state.scrollY}:${state.zoom}|${items}`
}

export default function PlaceholderOverlay({ editor }: { editor: CanvasEditor }) {
  const [state, setState] = useState<OverlayState>(() => snapshot(editor))

  useEffect(() => {
    const update = () => {
      const next = snapshot(editor)
      setState((prev) => (renderSignature(prev) === renderSignature(next) ? prev : next))
    }
    update()
    return editor.onChange(update)
  }, [editor])

  if (state.placeholders.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {state.placeholders.map((p) => {
        const accent = STATUS_ACCENT[p.status]
        const isLoading = p.status === 'loading'
        return (
          <div
            key={p.id}
            className="absolute"
            style={{
              left: (p.x + state.scrollX) * state.zoom,
              top: (p.y + state.scrollY) * state.zoom,
              width: p.w,
              height: p.h,
              transform: `scale(${state.zoom})`,
              transformOrigin: 'top left',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: 16,
                boxSizing: 'border-box',
                color: '#cbd5e1',
                textAlign: 'center',
                fontSize: 13,
                lineHeight: 1.4,
              }}
            >
              {isLoading ? (
                <>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      border: `3px solid ${accent}`,
                      borderTopColor: 'transparent',
                      borderRadius: '50%',
                      animation: 'canvas-placeholder-spin 0.8s linear infinite',
                    }}
                  />
                  <span>生成中…</span>
                </>
              ) : (
                <>
                  <span style={{ color: accent, fontWeight: 600 }}>
                    {p.status === 'error' ? '生成失败' : '任务失效'}
                  </span>
                  {p.message && (
                    <span style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{p.message}</span>
                  )}
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => retryCanvasTask(editor, p)}
                    style={{
                      marginTop: 4,
                      padding: '4px 14px',
                      fontSize: 13,
                      fontWeight: 500,
                      color: '#fff',
                      background: accent,
                      border: 'none',
                      borderRadius: 8,
                      cursor: 'pointer',
                      pointerEvents: 'all',
                    }}
                  >
                    重试
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
