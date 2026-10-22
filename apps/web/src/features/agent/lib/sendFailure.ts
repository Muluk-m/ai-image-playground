import { IMAGE_DATA_URL_MAX_CHARS } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { MediaRequestError } from '../../../lib/cloudMedia'
import { AgentRequestError, AgentTransportError } from './agentClient'
import {
  attachmentUploadErrorMessage,
  canRetryAttachmentUpload,
  formatImageLimit,
} from './attachmentUploadErrors'
import { referenceImageLimit } from './attachmentUploads'

/** 一条话没能发出去时给用户看的那一句：原因 + 下一步；`retryable` 决定卡片上有没有「重试」。 */
export interface SendFailure {
  readonly message: string
  readonly retryable: boolean
}

/** 服务端 schema 报的是参考图字节超了请求体那道上限（`/references/0/dataUrl: Expected string length…`）。 */
function referenceTooLong(message: string | undefined): boolean {
  return Boolean(
    message &&
      /\/references\/\d+\/(mask)?dataUrl/i.test(message) &&
      (/length/i.test(message) || message.includes(String(IMAGE_DATA_URL_MAX_CHARS))),
  )
}

/**
 * 发话在服务端收下之前失败：按错误种类给出能看懂的原因与下一步。认不出的返回 undefined，
 * 调用方用它原来的兜底文案。错误详情（请求号、原始报错）仍在「错误详情」里。
 */
export function describeSendFailure(thrown: unknown): SendFailure | undefined {
  const tooLarge = () => ({
    message: i18next.t('error.imageTooLarge', {
      ns: 'agent',
      maxSize: formatImageLimit(referenceImageLimit().imageBytes),
    }),
    retryable: false,
  })
  if (thrown instanceof MediaRequestError) {
    if (['media_too_large', 'media_image_too_large'].includes(thrown.code)) return tooLarge()
    return {
      message: i18next.t('error.uploadFailed', {
        ns: 'agent',
        reason: attachmentUploadErrorMessage(thrown.code),
      }),
      retryable: canRetryAttachmentUpload(thrown.code),
    }
  }
  if (thrown instanceof AgentRequestError) {
    if (thrown.status === 413 || referenceTooLong(thrown.serverMessage)) return tooLarge()
    if (thrown.status === 429)
      return { message: i18next.t('error.rateLimited', { ns: 'agent' }), retryable: true }
    if (thrown.code === 'invalid_selection')
      return { message: i18next.t('error.invalidSelection', { ns: 'agent' }), retryable: false }
    if (thrown.code === 'invalid_reference')
      return { message: i18next.t('error.invalidReference', { ns: 'agent' }), retryable: false }
    if (thrown.status === 401)
      return { message: i18next.t('error.signedOut', { ns: 'agent' }), retryable: false }
    if (thrown.status >= 500)
      return { message: i18next.t('error.serverUnavailable', { ns: 'agent' }), retryable: true }
    if (thrown.status === 400 || thrown.status === 422)
      return { message: i18next.t('error.requestRejected', { ns: 'agent' }), retryable: false }
    return undefined
  }
  if (thrown instanceof AgentTransportError || thrown instanceof TypeError)
    return { message: i18next.t('error.network', { ns: 'agent' }), retryable: true }
  return undefined
}
