import { type ConnectionLineComponentProps, getBezierPath } from '@xyflow/react'

/** 拖线预览：沿用节点连线的贝塞尔方向，避免预览和落盘后的线出现折点。 */
export default function NodeConnectionLine({
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
  connectionStatus,
  connectionLineStyle,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  })
  const status = connectionStatus ?? 'pending'
  return (
    <g className={`studio-node-connection-preview studio-node-connection-preview--${status}`}>
      <path d={path} className="studio-node-connection-preview-path" style={connectionLineStyle} />
      <path
        d={path}
        pathLength={100}
        className="studio-node-connection-preview-energy"
        aria-hidden="true"
      />
    </g>
  )
}
