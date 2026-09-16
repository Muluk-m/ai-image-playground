import { i18next } from '../i18n'
/** API 支持的最大参考图数量。 */
export const API_MAX_IMAGES = 16

function buildMaxInputImagesMessage(): string {
  return i18next.t('image.limitReached', { ns: 'lib', max: API_MAX_IMAGES })
}

/** `export let` 的 live binding：语言切换后已 import 这条文案的模块读到的是新一份。 */
export let MAX_INPUT_IMAGES_MESSAGE = buildMaxInputImagesMessage()
i18next.on('languageChanged', () => {
  MAX_INPUT_IMAGES_MESSAGE = buildMaxInputImagesMessage()
})
