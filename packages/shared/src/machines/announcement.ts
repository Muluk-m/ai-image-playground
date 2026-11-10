import { ANNOUNCEMENT_STATUSES, type AnnouncementStatus } from '../announcements'
import { defineMachine } from '../state-machine'

/**
 * 公告库存状态。有效状态（到点公开、过期隐藏）仍由 `effectiveAnnouncementStatus` 按时间计算，
 * 不写回这一列。`revise` 不改状态，只表示「未归档才可以改正文」。
 */
export const announcementPublication = defineMachine({
  id: 'announcement-publication',
  states: ANNOUNCEMENT_STATUSES,
  events: ['publish', 'schedule', 'unpublish', 'archive', 'revise'] as const,
  transitions: {
    draft: {
      publish: 'published',
      schedule: 'scheduled',
      archive: 'archived',
      revise: 'draft',
    },
    scheduled: {
      publish: 'published',
      schedule: 'scheduled',
      unpublish: 'draft',
      archive: 'archived',
      revise: 'scheduled',
    },
    published: {
      publish: 'published',
      schedule: 'scheduled',
      unpublish: 'draft',
      archive: 'archived',
      revise: 'published',
    },
    archived: { archive: 'archived' },
  },
})

export type AnnouncementEvent = (typeof announcementPublication.events)[number]

export function announcementPublishEvent(publishAt: number, now: number): 'publish' | 'schedule' {
  return publishAt > now ? 'schedule' : 'publish'
}

export function canReviseAnnouncement(status: AnnouncementStatus): boolean {
  return announcementPublication.allows(status, 'revise')
}
