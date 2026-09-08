import { IMAGE_DATA_URL_MAX_CHARS } from '@image-playground/shared'
import { Elysia, t } from 'elysia'

export const imageDataUrlSchema = () =>
  t.String({ pattern: '^data:image/', maxLength: IMAGE_DATA_URL_MAX_CHARS })

/** Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。 */
export const badRequestOnValidation = () =>
  new Elysia().onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
