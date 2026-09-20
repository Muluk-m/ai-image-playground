import { i18next } from '../i18n'
/** API 支持的最大参考图数量。 */
export const API_MAX_IMAGES = 16

/**
 * 单张参考图的上限。上游把图连同提示词一起放进一次请求里，太大的原图既传不上去也没意义
 * （模型端本来就会缩），所以在进输入框之前就拦掉，而不是等提交失败。
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_MB = MAX_IMAGE_BYTES / (1024 * 1024)

function buildMaxInputImagesMessage(): string {
  return i18next.t('image.limitReached', { ns: 'lib', max: API_MAX_IMAGES })
}

/** `export let` 的 live binding：语言切换后已 import 这条文案的模块读到的是新一份。 */
export let MAX_INPUT_IMAGES_MESSAGE = buildMaxInputImagesMessage()
i18next.on('languageChanged', () => {
  MAX_INPUT_IMAGES_MESSAGE = buildMaxInputImagesMessage()
})
