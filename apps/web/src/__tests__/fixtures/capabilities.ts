import {
  CAPABILITIES,
  type ClientCapabilityKey,
  type ClientCapabilityManifest,
} from '@image-playground/shared'

/** 清单要求每个客户端可见的能力都在场；用例摊开这份再打开它要的那几个。 */
export function allCapabilitiesOff(): ClientCapabilityManifest {
  const manifest: Partial<Record<ClientCapabilityKey, boolean>> = {}
  for (const [key, definition] of Object.entries(CAPABILITIES)) {
    if (definition.clientExposed) manifest[key as ClientCapabilityKey] = false
  }
  return manifest as ClientCapabilityManifest
}
