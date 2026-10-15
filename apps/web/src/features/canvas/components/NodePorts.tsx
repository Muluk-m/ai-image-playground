import { Handle, Position } from '@xyflow/react'
import { createContext, useContext, useRef, useState } from 'react'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

export const SpawnContext = createContext<(nodeId: string, side: 'left' | 'right') => void>(
  () => {},
)

function MagneticPort({ nodeId, side }: { nodeId: string; side: 'left' | 'right' }) {
  const { t } = useTranslation('canvas')
  const spawn = useContext(SpawnContext)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [following, setFollowing] = useState(false)
  const reset = () => {
    setOffset({ x: 0, y: 0 })
    setFollowing(false)
  }
  return (
    <Handle
      type={side === 'left' ? 'target' : 'source'}
      position={side === 'left' ? Position.Left : Position.Right}
      className="studio-node-handle"
      aria-label={t(side === 'left' ? 'nodes.connectIn' : 'nodes.connectOut')}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          spawn(nodeId, side)
        }
      }}
      onPointerDownCapture={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY }
      }}
      onClick={(event) => {
        const origin = pointer.current
        pointer.current = null
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) return
        event.stopPropagation()
        spawn(nodeId, side)
      }}
    >
      <span
        className="studio-node-port-range"
        onPointerMove={(event) => {
          if (event.buttons) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (!bounds.width) return
          const x = ((event.clientX - bounds.left - bounds.width / 2) * 64) / bounds.width
          const y = ((event.clientY - bounds.top - bounds.height / 2) * 64) / bounds.height
          setOffset({ x, y })
          setFollowing(true)
        }}
        onPointerLeave={reset}
      >
        <span
          className="studio-node-port-button"
          data-following={following}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        >
          <Icon name="add" size="xs" />
        </span>
      </span>
    </Handle>
  )
}

/** Hit areas stay still, so the moving button cannot escape an immediate click or shift an edge. */
export default function NodePorts({ nodeId }: { nodeId: string }) {
  return (
    <>
      <MagneticPort nodeId={nodeId} side="left" />
      <MagneticPort nodeId={nodeId} side="right" />
    </>
  )
}
