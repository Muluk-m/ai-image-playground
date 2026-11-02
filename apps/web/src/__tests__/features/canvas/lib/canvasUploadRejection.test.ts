import { expect, it } from 'vitest'
import { canvasUploadRejection } from '../../../../features/canvas/lib/projectMedia'
import { MediaRequestError } from '../../../../lib/cloudMedia'

it('treats an upload 413 as oversized even when the body has no size error code', () => {
  expect(canvasUploadRejection(new MediaRequestError(413, 'media_upload_failed'))).toBe('oversized')
  expect(canvasUploadRejection(new MediaRequestError(413, 'media_unavailable'))).toBe('oversized')
  expect(canvasUploadRejection(new MediaRequestError(422, 'media_invalid_image'))).toBe('invalid')
  expect(canvasUploadRejection(new MediaRequestError(503, 'media_network_error'))).toBeUndefined()
})
