import { scopedStorageName } from '../../../lib/authScope'

export function canvasSceneKey(conversationId: string | null): string {
  return `${scopedStorageName('canvas')}:${conversationId ? `conversation:${encodeURIComponent(conversationId)}` : 'draft'}`
}
