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
    if (typeof record[key] !== 'boolean') return null
    manifest[key as ClientCapabilityKey] = record[key]
  }
  return manifest
}
let currentManifest = disabledManifest()
let currentBffEnabled = false

export async function bootstrapClientCapabilities(
  bffEnabled: boolean,
  bffBaseUrl: string,
): Promise<ClientCapabilityManifest> {
  currentManifest = disabledManifest()
  currentBffEnabled = bffEnabled
  if (!bffEnabled) return currentManifest

  try {
    const response = await fetch(`${bffBaseUrl.replace(/\/+$/, '')}/api/capabilities`, {
      cache: 'no-store',
    })
    if (!response.ok) return currentManifest
    const parsed = parseManifest(await response.json())
    if (parsed) currentManifest = parsed
  } catch {
    // A missing capability response must never enable a feature.
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
