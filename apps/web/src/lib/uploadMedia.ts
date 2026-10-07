import { accountScope } from './authScope'
import { transferMedia } from './mediaTransfer'
import { bffBaseUrl } from './runtimeConfig'

/** Existing signed media upload protocol shared by canvas and user reference uploads. */
export async function uploadMediaBytes(
  body: ArrayBuffer,
  contentType: string,
  sha256: string,
  signal: AbortSignal,
): Promise<string> {
  const sameAccount = accountScope()
  const backend = bffBaseUrl()
  const current = () => {
    signal.throwIfAborted()
    if (!sameAccount() || backend !== bffBaseUrl()) throw new Error('media_scope_changed')
  }
  current()
  const upload = await transferMedia(body, contentType, sha256, { signal, current })
  current()
  return upload.id
}
