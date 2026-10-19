import { BaseEdge, type EdgeProps, getBezierPath, Position } from '@xyflow/react'

export default function NodeFlowEdge(props: EdgeProps) {
  const [path] = getBezierPath({
    ...props,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  })
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
