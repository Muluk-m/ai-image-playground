import { defineMachine } from '@image-playground/shared'

/**
 * 一张参考图从排队到可用。`reuse` 是摘要已经传过、跳过直传。
 * `finish` 在确认前也可能直接发生：预留接口已经返回 ready 时不再进入 verifying。
 * `fail` 从 ready 也能发生，因为成功回调之后的计时上报若抛错，现有 catch 仍会把状态标成失败。
 */
export const mediaUpload = defineMachine({
  id: 'media-upload',
  states: ['queued', 'uploading', 'verifying', 'ready', 'failed'] as const,
  events: ['begin', 'verify', 'finish', 'reuse', 'fail'] as const,
  transitions: {
    queued: { begin: 'uploading', reuse: 'ready', fail: 'failed' },
    uploading: { verify: 'verifying', finish: 'ready', fail: 'failed' },
    verifying: { finish: 'ready', fail: 'failed' },
    ready: { fail: 'failed' },
    failed: {},
  },
})

export type MediaUploadEvent = (typeof mediaUpload.events)[number]
