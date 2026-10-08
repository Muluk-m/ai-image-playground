import type { AttachmentLimits } from '@image-playground/shared'
import { i18next } from '../../../i18n'

const messages = {
  attachment_capability_unavailable: 'attachment.attachment_capability_unavailable',
  attachment_uploads_unavailable: 'attachment.attachment_uploads_unavailable',
  media_unsupported_image: 'attachment.media_unsupported_image',
  media_image_too_large: 'attachment.media_image_too_large',
  media_too_large: 'attachment.media_too_large',
  media_image_pixels_exceeded: 'attachment.media_image_pixels_exceeded',
  media_quota_exceeded: 'attachment.media_quota_exceeded',
  media_invalid_image: 'attachment.media_invalid_image',
  media_image_processing_limit: 'attachment.media_image_processing_limit',
  media_processing_busy: 'attachment.media_processing_busy',
  media_storage_unavailable: 'attachment.media_storage_unavailable',
  media_not_readable: 'attachment.media_not_readable',
  media_upload_expired: 'attachment.media_upload_expired',
  media_hash_mismatch: 'attachment.media_hash_mismatch',
  media_size_mismatch: 'attachment.media_size_mismatch',
  media_descriptor_mismatch: 'attachment.media_descriptor_mismatch',
  media_upload_failed: 'attachment.media_upload_failed',
  media_network_error: 'attachment.media_network_error',
  media_timeout: 'attachment.media_timeout',
  unauthorized: 'attachment.unauthorized',
  attachment_storage_failed: 'attachment.attachment_storage_failed',
  attachment_read_failed: 'attachment.attachment_read_failed',
} as const

export function attachmentUploadErrorMessage(code: string | undefined, limits?: AttachmentLimits) {
  const t = i18next.getFixedT(null, 'errors')
  if (
    !limits &&
    ['media_image_pixels_exceeded', 'media_image_too_large', 'media_too_large'].includes(code ?? '')
  )
    return t('attachment.image_limit_unknown')
  const key = Object.prototype.hasOwnProperty.call(messages, code ?? '')
    ? messages[code as keyof typeof messages]
    : 'attachment.fallback'
  return t(key, {
    maxPixels: limits?.imagePixels.toLocaleString(i18next.language),
    maxSize: limits ? `${Math.round((limits.imageBytes / 1024 / 1024) * 10) / 10} MiB` : undefined,
  })
}

export function canRetryAttachmentUpload(code: string | undefined) {
  return ![
    'attachment_storage_failed',
    'attachment_read_failed',
    'attachment_capability_unavailable',
    'attachment_uploads_unavailable',
    'media_image_too_large',
    'media_too_large',
    'media_image_pixels_exceeded',
    'media_image_processing_limit',
    'media_unsupported_image',
    'media_descriptor_mismatch',
  ].includes(code ?? '')
}
