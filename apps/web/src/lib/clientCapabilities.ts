import {
  type AttachmentLimits,
  CAPABILITIES,
  type CapabilityKey,
  type ClientCapabilityKey,
  type ClientCapabilityManifest,
  canvasUploadConflictsSupported,
} from '@image-playground/shared'

function disabledManifest(): ClientCapabilityManifest {
  const manifest: Partial<Record<ClientCapabilityKey, boolean>> = {}
  for (const [key, definition] of Object.entries(CAPABILITIES)) {
    if (definition.clientExposed) manifest[key as ClientCapabilityKey] = false
  }
  return manifest as ClientCapabilityManifest
}

function parseManifest(input: unknown): ClientCapabilityManifest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const manifest = { ...disabledManifest() }
  for (const [key, definition] of Object.entries(CAPABILITIES)) {
    if (!definition.clientExposed) continue
    // Older BFFs omit newer flags; leave those disabled without hiding existing features.
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (typeof record[key] !== 'boolean') return null
    manifest[key as ClientCapabilityKey] = record[key]
  }
  return manifest
}

let currentManifest = disabledManifest()
let projectDocumentIdentity = false
let canvasPendingMedia = false
let attachmentLimits: AttachmentLimits | undefined
const CAPABILITY_RETRY_DELAYS_MS = [5000, 10_000]
const CAPABILITY_DEADLINE_MS = 30_000

export async function bootstrapClientCapabilities(
  bffEnabled: boolean,
  bffBaseUrl: string,
  required = false,
): Promise<ClientCapabilityManifest> {
  currentManifest = disabledManifest()
  projectDocumentIdentity = false
  canvasPendingMedia = false
  attachmentLimits = undefined
  if (!bffEnabled) return currentManifest

  let result: { body: unknown; parsed: ClientCapabilityManifest | null } | null = null
  try {
    result = await requestManifest(bffBaseUrl)
    if (!result?.parsed && required) throw new Error('capability_manifest_unavailable')
    if (result?.parsed) {
      currentManifest = result.parsed
    }
    const body = result?.body
    if (
      result?.parsed?.['agent:attachments'] &&
      result.parsed['agent:bulk-attachments'] === true &&
      typeof body === 'object' &&
      body !== null &&
      'attachmentLimits' in body
    ) {
      const limits = body.attachmentLimits as AttachmentLimits | null
      if (
        limits &&
        [
          limits.logicalReferences,
          limits.imageBytes,
          limits.imagePixels,
          limits.uploadConcurrency,
        ].every((value) => Number.isSafeInteger(value) && value > 0) &&
        limits.logicalReferences <= 100 &&
        limits.uploadConcurrency <= 4
      )
        attachmentLimits = limits
    }
    projectDocumentIdentity =
      result?.parsed !== null &&
      typeof body === 'object' &&
      body !== null &&
      'projectDocumentIdentity' in body &&
      body.projectDocumentIdentity === true
    canvasPendingMedia =
      result?.parsed !== null &&
      typeof body === 'object' &&
      body !== null &&
      'canvasPendingMedia' in body &&
      body.canvasPendingMedia === true
  } catch (error) {
    // A missing capability response must never enable a feature.
    if (required) throw error
  }
  return currentManifest
}

async function requestManifest(
  bffBaseUrl: string,
): Promise<{ body: unknown; parsed: ClientCapabilityManifest } | null> {
  const controller = new AbortController()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise((resolve, reject) => {
      let started = 0
      let pending = 0
      let settled = false
      let retryable = true
      const finish = (deliver: () => void) => {
        if (settled) return
        settled = true
        deliver()
      }
      const start = () => {
        if (settled || !retryable || started > CAPABILITY_RETRY_DELAYS_MS.length) return
        clearTimeout(retryTimer)
        const delay = CAPABILITY_RETRY_DELAYS_MS[started++]
        pending++
        if (delay !== undefined) retryTimer = setTimeout(start, delay)
        // Keep earlier requests alive: cancelling at 5/10/15s discards every 16s response.
        void (async () => {
          const response = await fetch(`${bffBaseUrl.replace(/\/+$/, '')}/api/capabilities`, {
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok) {
            if ([408, 429, 500, 502, 503, 504].includes(response.status))
              throw new Error('capability_manifest_unavailable')
            return null
          }
          const body: unknown = await response.json()
          const parsed = parseManifest(body)
          if (!parsed) return null
          return { body, parsed }
        })().then(
          (result) => {
            pending--
            if (settled) return
            if (result) finish(() => resolve(result))
            else {
              retryable = false
              clearTimeout(retryTimer)
              if (pending === 0) finish(() => resolve(null))
            }
          },
          (error: unknown) => {
            pending--
            if (settled) return
            if (pending === 0 && (!retryable || started > CAPABILITY_RETRY_DELAYS_MS.length))
              finish(() => reject(error))
          },
        )
      }
      deadline = setTimeout(
        () => finish(() => reject(new Error('capability_request_timeout'))),
        CAPABILITY_DEADLINE_MS,
      )
      start()
    })
  } finally {
    clearTimeout(retryTimer)
    clearTimeout(deadline)
    controller.abort()
  }
}

/** Older APIs reject the new document fields; send them only after the server advertises support. */
export function supportsProjectDocumentIdentity(): boolean {
  return projectDocumentIdentity
}

/**
 * 旧 API 拒收带本机 fileId 的画布节点；服务端声明支持后才在图片上传完之前同步文档。
 * 先发文档要靠并发覆盖后的补写（依赖 Yjs 内部结构）；装上的 yjs 自检不通过时照旧等图片上云再同步。
 */
export function supportsCanvasPendingMedia(): boolean {
  return canvasPendingMedia && canvasUploadConflictsSupported()
}

export function getClientCapabilityManifest(): Readonly<ClientCapabilityManifest> {
  return currentManifest
}

export function isClientCapabilityEnabled(key: CapabilityKey): boolean {
  const definition = CAPABILITIES[key]
  if (!definition.clientExposed) return false
  return currentManifest[key as ClientCapabilityKey]
}

export function getAttachmentLimits(): Readonly<AttachmentLimits> | undefined {
  return attachmentLimits
}
