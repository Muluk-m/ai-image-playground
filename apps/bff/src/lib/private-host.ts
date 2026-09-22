/**
 * BFF 暴露给私有 overlay 的宿主面。规则同 `apps/web/src/lib/privateHost.ts`：
 * overlay 只许从这里与 `private-overlay.ts` 取公开树的东西；改这里 = 改对 overlay 的承诺，先扩后缩。
 */

export { config } from '../config'
export { db, schema } from '../db/client'
export { capabilityUnavailable, isCapabilityEnabled } from './capabilities'
export { getChannels } from './channels'
export { UserOperationError } from './user-admin'
export { requireInternalService, requireUser } from './user-auth'
