import {
  type AttachmentLimits,
  CAPABILITIES,
  type CapabilityKey,
  type ClientCapabilityKey,
  type ClientCapabilityManifest,
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
let currentBffEnabled = false
let projectDocumentIdentity = false
let attachmentLimits: AttachmentLimits | undefined
const CAPABILITY_TIMEOUT_MS = 5000

export async function bootstrapClientCapabilities(
  bffEnabled: boolean,
  bffBaseUrl: string,
  required = false,
): Promise<ClientCapabilityManifest> {
  currentManifest = disabledManifest()
  currentBffEnabled = bffEnabled
  projectDocumentIdentity = false
  attachmentLimits = undefined
  if (!bffEnabled) return currentManifest

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      fetch(`${bffBaseUrl.replace(/\/+$/, '')}/api/capabilities`, {
        cache: 'no-store',
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) return null
        const body: unknown = await response.json()
        return { body, parsed: parseManifest(body) }
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('capability_request_timeout'))
        }, CAPABILITY_TIMEOUT_MS)
      }),
    ])
    if (!result?.parsed && required) throw new Error('capability_manifest_unavailable')
    if (result?.parsed) currentManifest = result.parsed
    const body = result?.body
    if (
      result?.parsed?.['agent:attachments'] &&
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
  } catch (error) {
    // A missing capability response must never enable a feature.
    if (required) throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  return currentManifest
}

/** Older APIs reject the new document fields; send them only after the server advertises support. */
export function supportsProjectDocumentIdentity(): boolean {
  return projectDocumentIdentity
}

export function getClientCapabilityManifest(): Readonly<ClientCapabilityManifest> {
  return currentManifest
}

export function isClientCapabilityEnabled(key: CapabilityKey): boolean {
  const definition = CAPABILITIES[key]
  if (!definition.clientExposed) return false
  return currentManifest[key as ClientCapabilityKey]
}

/**
 * Static deployments remain BYOK workbenches. BFF deployments must opt in
 * through the server capability manifest; a missing manifest therefore fails closed.
 */
export function isByokGenerationEnabled(): boolean {
  return !currentBffEnabled || isClientCapabilityEnabled('generation:byok')
}

export function getAttachmentLimits(): Readonly<AttachmentLimits> | undefined {
  return attachmentLimits
}
