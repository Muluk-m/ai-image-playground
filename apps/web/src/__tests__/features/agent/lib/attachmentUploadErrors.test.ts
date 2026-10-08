// @vitest-environment jsdom
import { expect, it } from 'vitest'
import {
  attachmentUploadErrorMessage,
  canRetryAttachmentUpload,
} from '../../../../features/agent/lib/attachmentUploadErrors'

const limits = {
  logicalReferences: 100,
  imageBytes: 10 * 1024 * 1024,
  imagePixels: 40_000_000,
  uploadConcurrency: 1,
}

it('explains server pixel limits and byte limits separately with the advertised budgets', () => {
  expect(attachmentUploadErrorMessage('media_image_pixels_exceeded', limits)).toContain(
    '40,000,000',
  )
  expect(attachmentUploadErrorMessage('media_image_pixels_exceeded', limits)).toContain('缩小尺寸')
  expect(attachmentUploadErrorMessage('media_too_large', limits)).toContain('10 MiB')
  expect(attachmentUploadErrorMessage('media_image_too_large', limits)).toBe(
    attachmentUploadErrorMessage('media_too_large', limits),
  )
  expect(canRetryAttachmentUpload('media_image_pixels_exceeded')).toBe(false)
  expect(canRetryAttachmentUpload('media_too_large')).toBe(false)
})

it('distinguishes storage quota, invalid images, interrupted transfers and temporary failures', () => {
  expect(attachmentUploadErrorMessage('media_quota_exceeded', limits)).toContain('云端存储空间不足')
  expect(attachmentUploadErrorMessage('media_invalid_image', limits)).toContain('无法解析')
  expect(attachmentUploadErrorMessage('media_hash_mismatch', limits)).toContain('校验未通过')
  expect(attachmentUploadErrorMessage('media_processing_busy', limits)).toContain('繁忙')
  expect(attachmentUploadErrorMessage('media_storage_unavailable', limits)).toContain('暂时不可用')
  expect(attachmentUploadErrorMessage('media_network_error', limits)).toContain('网络')
  expect(attachmentUploadErrorMessage('media_timeout', limits)).toContain('超时')
  expect(canRetryAttachmentUpload('media_processing_busy')).toBe(true)
  expect(canRetryAttachmentUpload('media_network_error')).toBe(true)
  expect(attachmentUploadErrorMessage('unknown', limits)).toContain('图片上传失败')
})

it('uses a useful message when an older server has no advertised budgets', () => {
  expect(attachmentUploadErrorMessage('media_image_pixels_exceeded')).not.toContain('{{')
  expect(attachmentUploadErrorMessage('media_too_large')).not.toContain('{{')
})

it('explains the processing budget and does not offer an identical unsafe retry', () => {
  expect(attachmentUploadErrorMessage('media_image_processing_limit', limits)).toContain(
    '处理开销过大',
  )
  expect(canRetryAttachmentUpload('media_image_processing_limit')).toBe(false)
})
