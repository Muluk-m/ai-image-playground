import type { CanvasNode, CanvasSnapshot } from './canvas-document'

export const CANVAS_NODE_TYPES = ['text', 'image', 'video', 'timeline'] as const
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number]

interface CanvasNodeDefinition {
  inputs: readonly CanvasNodeType[]
  size: { width: number; height: number }
  description: string
}
/** Semantic kinds also cover an empty video card before its first result exists. */
export function canvasNodeKind(node: CanvasNode): CanvasNodeType {
  return node.type === 'image' && node.data.meta?.nodeKind === 'video' ? 'video' : node.type
}

export const canvasNodeRegistry = {
  text: {
    inputs: ['text', 'image'],
    size: { width: 300, height: 220 },
    description: 'Editable text, script or notes with text and image context.',
  },
  image: {
    inputs: ['text', 'image'],
    size: { width: 360, height: 240 },
    description: 'Generate or edit an image using direct text and image references.',
  },
  video: {
    inputs: ['text', 'image', 'video'],
    size: { width: 360, height: 240 },
    description: 'Generate video with explicit input mode and model capability checks.',
  },
  timeline: {
    inputs: ['video'],
    size: { width: 560, height: 240 },
    description: 'Ordered video shots, resolved from each source node primary result.',
  },
} as const satisfies Record<CanvasNodeType, CanvasNodeDefinition>

export function canvasKindsConnect(source: CanvasNodeType, target: CanvasNodeType): boolean {
  const inputs: readonly CanvasNodeType[] = canvasNodeRegistry[target].inputs
  return inputs.includes(source)
}
export function canvasConnectionAllowed(source: CanvasNode, target: CanvasNode): boolean {
  return (
    source.id !== target.id && canvasKindsConnect(canvasNodeKind(source), canvasNodeKind(target))
  )
}
export function canvasLinkAllowed(
  snapshot: Pick<CanvasSnapshot, 'nodes'>,
  link: { source: string; target: string },
): boolean {
  const source = snapshot.nodes.find((node) => node.id === link.source)
  const target = snapshot.nodes.find((node) => node.id === link.target)
  return Boolean(source && target && canvasConnectionAllowed(source, target))
}
