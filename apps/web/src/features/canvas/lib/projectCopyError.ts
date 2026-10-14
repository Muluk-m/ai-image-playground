import { i18next } from '../../../i18n'
import { ProjectRequestError } from './projectClient'

const messages = {
  project_quota_exceeded: 'projectCopy.project_quota_exceeded',
  project_deleted: 'projectCopy.project_deleted',
  project_not_found: 'projectCopy.project_not_found',
  unauthorized: 'projectCopy.unauthorized',
  canvas_sync_unavailable: 'projectCopy.canvas_sync_unavailable',
  account_changed: 'projectCopy.account_changed',
} as const

/** 复制失败只按错误码取文案。不认识的码，以及账号切换以外的普通异常，都走同一句兜底。 */
export function copyProjectErrorMessage(error: unknown): string {
  const t = i18next.getFixedT(null, 'errors')
  const code =
    error instanceof ProjectRequestError ? error.code : error instanceof Error ? error.message : ''
  const key = Object.prototype.hasOwnProperty.call(messages, code)
    ? messages[code as keyof typeof messages]
    : 'projectCopy.fallback'
  return t(key)
}
