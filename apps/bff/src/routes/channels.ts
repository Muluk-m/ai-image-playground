import type { ChannelDiscoveryResponse } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { getDiscoveredChannels } from '../lib/channels'

/**
 * GET /api/channels — 公开发现接口（无 auth，无 rate-limit）。
 *
 * 返回 sanitized channel 列表，不含 baseUrl / auth / allowedPaths。前端 boot
 * 时（在 runtime-config.json 的 bff.enabled=true 前提下）调一次，拿到内置 channel
 * 列表组装 profile 与 dispatch 路径。
 *
 * 没配 channels.json 或 channels.json 是空数组时返回 `{ channels: [] }`，前端
 * 自动退化为「仅 BYOK 可用」。
 */
export const channelsRoutes = new Elysia().get(
  '/api/channels',
  (): ChannelDiscoveryResponse => ({ channels: getDiscoveredChannels() }),
)
