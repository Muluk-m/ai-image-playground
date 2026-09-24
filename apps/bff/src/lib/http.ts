import { DEVICE_ID_HEADER, IMAGE_DATA_URL_MAX_CHARS } from '@image-playground/shared'
import { Elysia, t, type ValidationError } from 'elysia'
import { config } from '../config'

/**
 * 限速用的调用方地址。转发头带多跳时退回 `unknown`：拼起来的链条是调用方可控的，
 * 拿它当 key 等于把限速桶交给对方分配。
 */
export function clientAddress(request: Request, peerAddress: string | null): string {
  if (config.network.clientIpSource === 'peer') return peerAddress ?? 'unknown'
  const forwardedAddress = request.headers.get(config.network.clientIpSource)?.trim()
  if (!forwardedAddress || forwardedAddress.includes(',')) return 'unknown'
  return forwardedAddress
}

export const imageDataUrlSchema = () =>
  t.String({ pattern: '^data:image/', maxLength: IMAGE_DATA_URL_MAX_CHARS })

/** 浏览器持久化的匿名设备 ID，见 apps/web/src/lib/deviceId.ts。 */
export const deviceIdSchema = () => t.String({ minLength: 8, maxLength: 64 })

/**
 * GET 端点取设备 ID 的位置。它是纯 bearer，放 query string 等于抄进访问日志、
 * 代理日志和浏览器历史，所以只认请求头。
 */
export const deviceIdHeaderSchema = () => t.Object({ [DEVICE_ID_HEADER]: deviceIdSchema() })

/** Elysia 的 `message` 是整份校验报告序列化成的 JSON；对外只给第一处出错的字段与原因。 */
export function validationMessage(error: Pick<ValidationError, 'valueError'>): string {
  const first = error.valueError
  if (!first) return 'invalid request'
  return first.path ? `${first.path}: ${first.message}` : first.message
}

/** Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。 */
export const badRequestOnValidation = () =>
  new Elysia().onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: validationMessage(error) }
    }
  })
