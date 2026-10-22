import type { AdminCapabilityManifest, ClientCapabilityManifest } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { capabilityManifest, isCapabilityEnabled } from '../lib/capabilities'
import { requireInternalService } from '../lib/user-auth'

export const capabilitiesRoutes = new Elysia().get(
  '/api/capabilities',
  (): ClientCapabilityManifest & {
    readonly 'canvas:nodes': true
    readonly 'canvas:blank-generate': true
    readonly 'canvas:node-run': true
    readonly 'canvas:script': true
    projectDocumentIdentity: true
    /** 画布文档可带还在上传的本机图片节点（无 mediaId 的本机 fileId），客户端据此不再等上传完才同步。 */
    canvasPendingMedia: true
  } => ({
    ...capabilityManifest(),
    projectDocumentIdentity: true,
    canvasPendingMedia: true,
  }),
)

export const internalCapabilitiesRoutes = new Elysia().use(requireInternalService).get(
  '/internal/admin/capabilities',
  (): AdminCapabilityManifest => ({
    accounts_login: isCapabilityEnabled('accounts:login'),
    operator_console: isCapabilityEnabled('operator:console'),
  }),
)
