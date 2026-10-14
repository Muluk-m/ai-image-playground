import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { subscribeTheme } from '../../../theme'
import type {
  CanvasViewportBox,
  CanvasViewportFrame,
  CanvasViewportLink,
} from '../lib/canvasViewport'

const CanvasLodContext = createContext<'detail' | 'card'>('detail')

export function CanvasLodProvider({
  mode,
  children,
}: {
  mode: 'detail' | 'card'
  children: ReactNode
}) {
  return <CanvasLodContext.Provider value={mode}>{children}</CanvasLodContext.Provider>
}

export function useCanvasLod(): 'detail' | 'card' {
  return useContext(CanvasLodContext)
}

/** 缩远之后的节点：只留一块带名字的底，不再解码图片或挂编辑器。 */
export function NodeLodCard({ label }: { label?: string }) {
  return (
    <div className="studio-node studio-node-lod" data-lod="card">
      {label ? <span className="studio-node-lod-label">{label}</span> : null}
    </div>
  )
}

/**
 * 总览画在 React Flow 后面。节点太多时不挂 DOM，只按当前视口把盒子和连线画到这一张画布上。
 */
export function CanvasOverview({
  active,
  container,
  items,
  edges,
  frame,
  mountedIds,
}: {
  active: boolean
  container: { readonly current: HTMLElement | null }
  items: readonly CanvasViewportBox[]
  edges: readonly CanvasViewportLink[]
  frame: CanvasViewportFrame
  mountedIds: readonly string[]
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!active) return
    setHost(container.current)
  }, [container, active])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active || !host) return
    const width = host.clientWidth
    const height = host.clientHeight
    if (width <= 0 || height <= 0) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(width * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const style = getComputedStyle(host)
      const foreground = style.getPropertyValue('--foreground').trim()
      const muted = style.getPropertyValue('--muted-foreground').trim()
      ctx.fillStyle = foreground ? `hsl(${foreground} / 0.18)` : 'rgba(255,255,255,0.18)'
      ctx.strokeStyle = muted ? `hsl(${muted} / 0.45)` : 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1
      const boxes = new Map(items.map((item) => [item.id, item]))
      const { x: panX, y: panY, zoom } = frame
      const point = (item: CanvasViewportBox) => ({
        x: (item.x + item.width / 2) * zoom + panX,
        y: (item.y + item.height / 2) * zoom + panY,
      })
      ctx.beginPath()
      for (const edge of edges) {
        const source = boxes.get(edge.source)
        const target = boxes.get(edge.target)
        if (!source || !target) continue
        const from = point(source)
        const to = point(target)
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
      }
      ctx.stroke()
      const pinned = new Set(mountedIds)
      for (const item of items) {
        if (pinned.has(item.id)) continue
        const left = item.x * zoom + panX
        const top = item.y * zoom + panY
        const boxWidth = item.width * zoom
        const boxHeight = item.height * zoom
        if (left + boxWidth < 0 || top + boxHeight < 0 || left > width || top > height) continue
        ctx.fillRect(left, top, Math.max(boxWidth, 1), Math.max(boxHeight, 1))
      }
    }
    draw()
    // 颜色取自 CSS 变量，主题切换后要重画，不能等下一次平移。
    return subscribeTheme(draw)
  }, [active, host, items, edges, frame, mountedIds])
  if (!active || !host) return null
  return createPortal(
    <canvas ref={canvasRef} className="studio-node-overview" aria-hidden="true" />,
    host,
  )
}
