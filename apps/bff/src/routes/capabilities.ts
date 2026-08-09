import type { ClientCapabilityManifest } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { capabilityManifest, isCapabilityEnabled } from '../lib/capabilities'
import { requireInternalService } from '../lib/user-auth'

export const capabilitiesRoutes = new Elysia().get(
  '/api/capabilities',
  (): ClientCapabilityManifest => capabilityManifest(),
)

export const internalCapabilitiesRoutes = new Elysia()
  .use(requireInternalService)
  .get('/internal/admin/capabilities', () => ({
    operator_console: isCapabilityEnabled('operator:console'),
  }))
