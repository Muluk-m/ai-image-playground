import type { AdminCapabilityManifest, ClientCapabilityManifest } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { capabilityManifest, isCapabilityEnabled } from '../lib/capabilities'
import { requireInternalService } from '../lib/user-auth'

/**
 * 是否让客户端写入上传中的图片节点。已开着的旧版页面遇到别的设备的本机 fileId 会报缺图、存不了编辑，
 * 所以先发布能容忍这种节点的新读取端（#1452），旧页面换代后由本开关打开写入。
 */
export const CANVAS_PENDING_MEDIA_WRITES = true

export const capabilitiesRoutes = new Elysia().get(
  '/api/capabilities',
  (): ClientCapabilityManifest & {
    readonly 'canvas:nodes': true
    readonly 'canvas:blank-generate': true
    readonly 'canvas:node-run': true
    readonly 'canvas:script': true
    projectDocumentIdentity: true
    /**
     * 画布文档可带还在上传的本机图片节点（无 mediaId 的本机 fileId），客户端据此不再等上传完才同步。
     * 分阶段上线：先发布了能容忍上传中节点的读取端（#1452），旧版页面换代后这里打开写入。
     */
    canvasPendingMedia: boolean
  } => ({
    ...capabilityManifest(),
    projectDocumentIdentity: true,
    canvasPendingMedia: CANVAS_PENDING_MEDIA_WRITES,
  }),
)

export const internalCapabilitiesRoutes = new Elysia().use(requireInternalService).get(
  '/internal/admin/capabilities',
  (): AdminCapabilityManifest => ({
    accounts_login: isCapabilityEnabled('accounts:login'),
    operator_console: isCapabilityEnabled('operator:console'),
  }),
)
