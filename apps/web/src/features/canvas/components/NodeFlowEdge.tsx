import { BaseEdge, type EdgeProps, getBezierPath } from '@xyflow/react'

export default function NodeFlowEdge(props: EdgeProps) {
  const [curve] = getBezierPath({
    ...props,
    sourceX: props.sourceX + 40,
    targetX: props.targetX - 40,
  })
  const path = `M${props.sourceX},${props.sourceY} L${curve.slice(1)} L${props.targetX},${props.targetY}`
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={props.interactionWidth}
        markerEnd={props.markerEnd}
        style={props.style}
      />
      <path
        d={path}
        pathLength={100}
        className="studio-node-edge-energy"
        fill="none"
        aria-hidden="true"
      />
    </>
  )
}
