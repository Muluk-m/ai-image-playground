import type { CapabilityKey } from '@image-playground/shared'
import { status } from 'elysia'
import { config } from '../config'
import { clientCapabilityManifest, evaluateCapability } from './operator-config'

export interface CapabilityUnavailableBody {
  readonly error: 'capability_unavailable'
  readonly capability: CapabilityKey
}

export function isCapabilityEnabled(key: CapabilityKey): boolean {
  return evaluateCapability(config.operator, key)
}

export function capabilityManifest() {
  return clientCapabilityManifest(config.operator)
}

export function capabilityUnavailable(capability: CapabilityKey) {
  return status(404, {
    error: 'capability_unavailable',
    capability,
  } satisfies CapabilityUnavailableBody)
}
