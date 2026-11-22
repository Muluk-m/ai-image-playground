import { i18next } from '../../lib/privateHost'
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'

/**
 * 私有 overlay 自带语料。
 *
 * 为什么不直接往公开树的 catalog 里加：公开树必须能在 `private/` 缺席时独立构建，
 * 收费文案也不该出现在免费包里。所以 overlay 把自己的 namespace 在加载时注册进去。
 *
 * 为什么不复用公开树那份 `declare module 'i18next'`：`CustomTypeOptions.resources`
 * 只能声明一次，两处声明会冲突。所以这里用本地的 `tBilling` 提供同等的编译期 key 检查，
 * 而不去动公开树的类型增强。
 *
 * 量很小，两种语言一起注册，不像公开树那样给英文单独切 chunk。
 */
const NAMESPACE = 'billing'

i18next.addResourceBundle('zh-CN', NAMESPACE, zhCN, true, true)
i18next.addResourceBundle('en', NAMESPACE, en, true, true)

type Leaves<T> = T extends string
  ? ''
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`
    }[keyof T & string]

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/**
 * 复数后缀是 locale 的属性，不是 key 的一部分：中文只有 `_other`，英文要 `_one` 和 `_other`。
 * 调用方永远传不带后缀的基名加 `count`，由 i18next 按当前语言挑分支——所以类型这一侧也要把
 * 后缀剥掉，否则唯一能编过的写法就变成手动挑 key，复数规则就退化成一个三元表达式。
 */
type StripPluralSuffix<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K

export type BillingKey = StripPluralSuffix<Leaves<typeof zhCN>>

/**
 * 公开树的类型增强不认识 `billing` 这个 namespace（见上），带类型的 `i18next.t` 因此拒绝它。
 * key 的检查由 `BillingKey` 负责，这里只需要一个不带 catalog 类型的调用口。
 */
const translate = i18next.t.bind(i18next) as unknown as (
  key: string,
  options: Record<string, unknown>,
) => string

/**
 * 写错 key 或漏建 key 在 `pnpm typecheck` 就红。
 *
 * 它不是 hook，不会自己订阅语言变化：组件里必须同时调用一次本模块导出的 `useTranslation()`，
 * 否则切语言后这一块不会重渲染。
 */
export function tBilling(key: BillingKey, params?: Record<string, unknown>): string {
  return translate(key, { ns: NAMESPACE, ...params })
}

export { useTranslation } from '../../lib/privateHost'
