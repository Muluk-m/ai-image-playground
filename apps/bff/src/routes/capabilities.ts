import type { ClientCapabilityManifest } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { capabilityManifest } from '../lib/capabilities'

export const capabilitiesRoutes = new Elysia().get(
  '/api/capabilities',
  (): ClientCapabilityManifest => capabilityManifest(),
)
