import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

/**
 * 部署技能目录（ADR 0007：正文是随 BFF 镜像发布的文件，后台只读）。
 *
 * BFF 那条 `/api/agent/skills` 本身是公开的，这里仍旧走 forwardInternalBff：
 * 后台到 BFF 只保留一条出口，鉴权头、超时与错误形状不按端点分叉。
 */
export const skillsRoutes = new Elysia({ prefix: '/api' }).use(requireAuth).get(
  '/skills',
  ({ query }) => {
    const suffix = query.mode ? `?mode=${encodeURIComponent(query.mode)}` : ''
    return forwardInternalBff({ path: `/api/agent/skills${suffix}` })
  },
  { query: t.Object({ mode: t.Optional(t.String({ maxLength: 32 })) }) },
)
