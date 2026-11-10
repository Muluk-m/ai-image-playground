import { describe, expect, it } from 'vitest'
import type { MediaUploadState } from '../../lib/mediaUpload'
import { mediaUpload } from '../../lib/mediaUploadMachine'

describe('media upload', () => {
  it('matches the upload callback union', () => {
    type Missing = Exclude<MediaUploadState, (typeof mediaUpload.states)[number]>
    type Extra = Exclude<(typeof mediaUpload.states)[number], MediaUploadState>
    const covered: Missing extends never ? (Extra extends never ? true : never) : never = true
    expect(covered).toBe(true)
  })
  it('walks the direct upload and the already-known shortcut', () => {
    expect(mediaUpload.step('queued', 'begin')).toBe('uploading')
    expect(mediaUpload.step('uploading', 'verify')).toBe('verifying')
    expect(mediaUpload.step('verifying', 'finish')).toBe('ready')
    expect(mediaUpload.step('uploading', 'finish')).toBe('ready')
    expect(mediaUpload.step('queued', 'reuse')).toBe('ready')
  })

  it('fails from every non-terminal phase, including a ready upload whose report throws', () => {
    expect(mediaUpload.step('queued', 'fail')).toBe('failed')
    expect(mediaUpload.step('uploading', 'fail')).toBe('failed')
    expect(mediaUpload.step('verifying', 'fail')).toBe('failed')
    expect(mediaUpload.step('ready', 'fail')).toBe('failed')
    expect(mediaUpload.allows('failed', 'begin')).toBe(false)
    expect(mediaUpload.allows('queued', 'finish')).toBe(false)
  })
})
