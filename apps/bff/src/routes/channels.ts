import type { ChannelDiscoveryResponse } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { getDiscoveredChannels } from '../lib/channels'

/**
 * GET /api/channels — 公开端点，`accounts:login` 开着时匿名访客也照样放行。
 *
 * 之所以不设门禁：返回的是 `sanitizeChannel` 处理过的清单，不含 baseUrl / auth /
 * allowedPaths，唯一泄露的信息是「这个部署提供哪些模型」——那本来就写在前端的
 * 模型下拉框上。而未登录的工作台必须先拿到它才渲染得出那个下拉框；在这里要求
 * session，匿名访客连能选什么模型都看不见。真正花钱的动作（submit / queue /
 * sync）各自带 requireUser，门禁在那里，不在发现接口上。
 *
 * 前端 boot 时（在 runtime-config.json 的 bff.enabled=true 前提下）调一次，拿到内置
 * channel 列表组装 profile 与 dispatch 路径。
 *
 * 改这条路由时 sanitization 是硬约束：任何一个凭据面字段漏进 DiscoveredChannel，
 * 就等于对全互联网公开。
 *
 * 没配 channels.json 或 channels.json 是空数组时返回 `{ channels: [] }`，前端
 * 自动退化为「仅 BYOK 可用」。
 */
export const channelsRoutes = new Elysia().get(
  '/api/channels',
  (): ChannelDiscoveryResponse => ({ channels: getDiscoveredChannels() }),
)
