import {
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
const CAPABILITY_TIMEOUT_MS = 5000

export async function bootstrapClientCapabilities(
  bffEnabled: boolean,
  bffBaseUrl: string,
  required = false,
): Promise<ClientCapabilityManifest> {
  currentManifest = disabledManifest()
  currentBffEnabled = bffEnabled
  if (!bffEnabled) return currentManifest

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const parsed = await Promise.race([
      fetch(`${bffBaseUrl.replace(/\/+$/, '')}/api/capabilities`, {
        cache: 'no-store',
        signal: controller.signal,
      }).then(async (response) => (response.ok ? parseManifest(await response.json()) : null)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('capability_request_timeout'))
        }, CAPABILITY_TIMEOUT_MS)
      }),
    ])
    if (!parsed && required) throw new Error('capability_manifest_unavailable')
    if (parsed) currentManifest = parsed
  } catch (error) {
    // A missing capability response must never enable a feature.
    if (required) throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  return currentManifest
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
