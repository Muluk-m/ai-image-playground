import { defineMachine } from '../state-machine'

/** `media_objects.status`。已 ready 的确认是空操作，不走 `publish`。已 deleting 的回收直接返回，不重复写。 */
export const mediaObject = defineMachine({
  id: 'media-object',
  states: ['pending', 'ready', 'deleting'] as const,
  events: ['publish', 'reclaim'] as const,
  transitions: {
    pending: { publish: 'ready', reclaim: 'deleting' },
    ready: { reclaim: 'deleting' },
    deleting: {},
  },
})
