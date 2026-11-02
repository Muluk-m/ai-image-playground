import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath, Position } from '@xyflow/react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'

type NodeFlowEdgeData = {
  cutLabel?: string
  onCut?: () => void
}

export default function NodeFlowEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    ...props,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  })
  const data = props.data as NodeFlowEdgeData | undefined
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
      {props.selected && data?.onCut && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan studio-node-edge-cut"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            <Button
              variant="secondary"
              size="icon-xs"
              aria-label={data.cutLabel}
              onClick={(event) => {
                event.stopPropagation()
                data.onCut?.()
              }}
            >
              <Icon name="cut" />
            </Button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
