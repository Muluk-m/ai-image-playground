import { beforeEach } from 'vitest'
import { i18next } from '../../i18n'

/**
 * jsdom 的 `navigator.languages` 是 `['en-US']`，不钉死的话所有渲染型用例都按英文断言，
 * 历史上写死中文文案的用例会整片变红。产品侧的浏览器语言探测保持原样，只在测试里固定。
 * 用 `changeLanguage` 而不是 `setLocale`，避免往 localStorage 里写东西污染别的断言。
 */
beforeEach(async () => {
  await i18next.changeLanguage('zh-CN')
})
