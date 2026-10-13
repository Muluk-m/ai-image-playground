import type * as Y from 'yjs'
import type { CanvasOrigin, ImageNodeData, PendingGeneration } from './canvas-document'
import type { VideoGenerationRecord } from './video-generation'

/** Separate entries keep every fan-out request recoverable after a refresh or concurrent update. */
export interface CanvasNodeJob {
  id: string
  nodeId: string
  createdAt: number
  status: 'loading' | 'error' | 'stale'
  message: string
  meta: {
    nodeGeneration?: true
    nodeVideo?: true
    prompt: string
    source?: 'builtin-edge' | 'user-byok'
    clientRequestId: string
    bffRequestId?: string
    params?: Record<string, unknown>
    generation?: VideoGenerationRecord
    inputFingerprint?: string
    initialResultId?: string
  }
}
export function canvasNodeJobs(doc: Y.Doc, nodeId?: string): CanvasNodeJob[] {
  return [...doc.getMap<CanvasNodeJob>('nodeJobs').values()]
    .filter((job) => nodeId === undefined || job.nodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
export function setCanvasNodeJob(doc: Y.Doc, job: CanvasNodeJob, origin: CanvasOrigin): void {
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(job.nodeId)
  if (!node) return
  doc.transact(() => {
    doc.getMap<CanvasNodeJob>('nodeJobs').set(job.id, job)
    const data = node.get('data') as ImageNodeData
    if (data.pending) {
      const { pending: _old, ...rest } = data
      node.set('data', rest)
    }
  }, origin)
}
export function finishCanvasNodeJob(doc: Y.Doc, id: string, origin: CanvasOrigin): void {
  doc.transact(() => doc.getMap('nodeJobs').delete(id), origin)
}
export function canvasPendingJob(doc: Y.Doc, nodeId: string): PendingGeneration | undefined {
  const jobs = canvasNodeJobs(doc, nodeId)
  const active = jobs.find((job) => job.status === 'loading') ?? jobs[jobs.length - 1]
  return active
    ? { type: 'placeholder', status: active.status, message: active.message, meta: active.meta }
    : undefined
}
