import { accountScope } from './authScope'
import { MediaRequestError, mediaJson } from './cloudMedia'

interface Upload {
  id: string
  status: 'ready' | 'pending'
  uploadUrl?: string
}

/** Existing signed media upload protocol shared by canvas and user reference uploads. */
export async function uploadMediaBytes(
  body: ArrayBuffer,
  contentType: string,
  sha256: string,
  signal: AbortSignal,
): Promise<string> {
  const sameAccount = accountScope()
  const current = () => {
    signal.throwIfAborted()
    if (!sameAccount()) throw new Error('media_scope_changed')
  }
  current()
  const upload = await mediaJson<Upload>('/uploads', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bytes: body.byteLength, contentType, sha256 }),
  })
  current()
  if (upload.status !== 'ready') {
    if (!upload.uploadUrl) throw new Error('invalid_media_upload')
    const sent = await fetch(upload.uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      headers: { 'content-type': contentType },
      body,
    })
    if (!sent.ok) throw new MediaRequestError(sent.status, 'media_upload_failed')
    current()
    const complete = await mediaJson<Upload>(`/${upload.id}/complete`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (complete.status !== 'ready' || complete.id !== upload.id)
      throw new Error('invalid_media_confirmation')
  }
  current()
  return upload.id
}
