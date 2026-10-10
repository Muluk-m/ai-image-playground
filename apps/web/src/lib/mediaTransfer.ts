import { accountScope, scopedStorageName } from './authScope'
import { MediaRequestError, mediaJson } from './cloudMedia'
import { bffBaseUrl } from './runtimeConfig'

interface Upload {
  id: string
  status: 'ready' | 'pending'
  uploadUrl?: string
  leaseExpiresAt?: number
}

async function retry<T>(work: () => Promise<T>, signal: AbortSignal, current: () => void) {
  for (let attempt = 0; ; attempt++) {
    current()
    try {
      return await work()
    } catch (error) {
      current()
      const transient =
        error instanceof MediaRequestError
          ? [408, 429, 500, 502, 503, 504].includes(error.status)
          : error instanceof TypeError ||
            (error instanceof DOMException && error.name === 'TimeoutError')
      if (!transient || attempt >= 3) throw error
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          reject(signal.reason)
        }
        const timer = setTimeout(
          () => {
            signal.removeEventListener('abort', abort)
            resolve()
          },
          500 * 2 ** attempt,
        )
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  }
}

interface Confirmation {
  promise: Promise<Upload>
  controller: AbortController
  waiters: number
}
const confirmations = new Map<string, Confirmation>()

function confirmMedia(
  id: string,
  signal: AbortSignal,
  schedule?: (work: () => Promise<Upload>) => Promise<Upload>,
): Promise<Upload> {
  signal.throwIfAborted()
  const backend = bffBaseUrl()
  const sameAccount = accountScope()
  const key = JSON.stringify([backend, scopedStorageName('media-confirm'), id])
  let entry = confirmations.get(key)
  if (!entry) {
    const controller = new AbortController()
    const current = () => {
      controller.signal.throwIfAborted()
      if (!sameAccount() || backend !== bffBaseUrl()) throw new Error('media_scope_changed')
    }
    const work = () =>
      retry(
        () =>
          mediaJson<Upload>(
            `/${id}/complete`,
            {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json' },
              body: '{}',
            },
            90_000,
          ),
        controller.signal,
        current,
      )
    const created: Confirmation = {
      controller,
      waiters: 0,
      promise: Promise.resolve()
        .then(() => (schedule ? schedule(work) : work()))
        .finally(() => {
          if (confirmations.get(key) === created) confirmations.delete(key)
        }),
    }
    entry = created
    confirmations.set(key, entry)
  }
  const shared = entry
  shared.waiters++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (deliver: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', aborted)
      shared.waiters--
      if (shared.waiters === 0) {
        if (confirmations.get(key) === shared) confirmations.delete(key)
        shared.controller.abort()
      }
      deliver()
    }
    const aborted = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', aborted, { once: true })
    shared.promise.then(
      (result) =>
        finish(() => {
          if (!sameAccount() || backend !== bffBaseUrl()) reject(new Error('media_scope_changed'))
          else resolve(result)
        }),
      (error: unknown) => finish(() => reject(error)),
    )
    if (signal.aborted) aborted()
  })
}

/** Reservation by hash, PUT to the same staging key and completion are all idempotent. */
export async function transferMedia(
  body: ArrayBuffer,
  contentType: string,
  sha256: string,
  options: {
    signal: AbortSignal
    current: () => void
    purpose?: 'conversation-attachment'
    onVerifying?: () => void
    confirm?: (work: () => Promise<Upload>) => Promise<Upload>
  },
): Promise<Upload> {
  const { signal, current } = options
  const reserve = () =>
    mediaJson<Upload>('/uploads', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bytes: body.byteLength,
        contentType,
        sha256,
        ...(options.purpose ? { purpose: options.purpose } : {}),
      }),
    })
  let upload = await retry(reserve, signal, current)
  current()
  if (upload.status === 'ready') return upload
  let refresh = false
  upload = await retry(
    async () => {
      if (refresh) {
        upload = await reserve()
        current()
        refresh = false
      }
      if (upload.status === 'ready') return upload
      if (!upload.uploadUrl) throw new Error('invalid_media_upload')
      let sent: Response
      try {
        sent = await fetch(upload.uploadUrl, {
          method: 'PUT',
          credentials: 'omit',
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
          headers: { 'content-type': contentType },
          body,
        })
      } catch (error) {
        // Expired signatures can surface as CORS network errors in a browser.
        refresh = true
        throw error
      }
      current()
      if (sent.status === 403) {
        // Refresh an expired signed URL without allocating a new media identity.
        refresh = true
        throw new MediaRequestError(503, 'media_upload_failed')
      }
      if (!sent.ok) throw new MediaRequestError(sent.status, 'media_upload_failed')
      return upload
    },
    signal,
    current,
  )
  if (upload.status === 'ready') return upload
  options.onVerifying?.()
  const ready = await confirmMedia(upload.id, signal, options.confirm)
  current()
  if (ready.status !== 'ready' || ready.id !== upload.id)
    throw new Error('invalid_media_confirmation')
  return { ...ready, leaseExpiresAt: ready.leaseExpiresAt ?? upload.leaseExpiresAt }
}
