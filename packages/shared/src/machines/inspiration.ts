import { INSPIRATION_STATUSES, type InspirationStatus } from '../inspiration'
import { defineMachine } from '../state-machine'

/**
 * 灵感条目的库存状态。现网 `setInspirationStatus` 接受三种状态之间的任意写入（含自身），
 * 这张表把这个事实记下来，不在这里收紧，避免改运营接口。
 * `remove` 只在非 published 上成立，对应「已发布必须先归档才能删」。
 */
export const inspirationPublication = defineMachine({
  id: 'inspiration-publication',
  states: INSPIRATION_STATUSES,
  events: ['to_draft', 'to_published', 'to_archived', 'remove'] as const,
  transitions: {
    draft: {
      to_draft: 'draft',
      to_published: 'published',
      to_archived: 'archived',
      remove: 'draft',
    },
    published: {
      to_draft: 'draft',
      to_published: 'published',
      to_archived: 'archived',
    },
    archived: {
      to_draft: 'draft',
      to_published: 'published',
      to_archived: 'archived',
      remove: 'archived',
    },
  },
})

export function inspirationStatusEvent(
  status: InspirationStatus,
): 'to_draft' | 'to_published' | 'to_archived' {
  switch (status) {
    case 'draft':
      return 'to_draft'
    case 'published':
      return 'to_published'
    case 'archived':
      return 'to_archived'
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}
