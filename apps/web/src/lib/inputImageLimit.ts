import { MAX_IMAGE_UPLOAD_BYTES, QUEUE_MAX_INPUT_IMAGES } from '@image-playground/shared'
import { i18next } from '../i18n'
/** API 支持的最大参考图数量。BFF 的提交校验用同一个数，超了会 400。 */
export const API_MAX_IMAGES = QUEUE_MAX_INPUT_IMAGES

/** 上传保留原件；模型输入的缩放和请求预算由提交路径处理。 */
export const MAX_IMAGE_BYTES = MAX_IMAGE_UPLOAD_BYTES
export const MAX_IMAGE_MB = MAX_IMAGE_BYTES / (1024 * 1024)

function buildMaxInputImagesMessage(): string {
  return i18next.t('image.limitReached', { ns: 'lib', max: API_MAX_IMAGES })
}

/** `export let` 的 live binding：语言切换后已 import 这条文案的模块读到的是新一份。 */
export let MAX_INPUT_IMAGES_MESSAGE = buildMaxInputImagesMessage()
i18next.on('languageChanged', () => {
  MAX_INPUT_IMAGES_MESSAGE = buildMaxInputImagesMessage()
})
