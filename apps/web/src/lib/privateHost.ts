/**
 * 公开树暴露给私有 overlay 的**宿主面**。
 *
 * overlay 只许从这里（和 `privateOverlay.tsx` 的契约类型）拿公开树的东西，不许 `../../../apps/web/src/...`
 * 深路径乱引——否则整棵源码树都成了它的 API，任何重构都可能悄悄打断收费版
 * （`scripts/check-private-boundary.ts` 反向扫描 `private/` 强制这条）。
 *
 * 这里每一行都是一个承诺：改名、删除、换签名之前，先确认 `verified` 那份 overlay 不再用它
 * （公开 CI 的 overlay-present 作业就在查这个），先扩后缩。
 *
 * 与 `privateOverlay.tsx` 分开放：那边 eager-glob 加载 overlay，如果再从那边 re-export
 * 宿主模块，overlay 与 seam 就互相 import，ESM 求值顺序会咬到自己。
 */

export { LoginMethodsPanel } from '../auth/LoginMethodsPanel'
export { default as BrandAvatar } from '../components/BrandAvatar'
export { default as DisplaySettingsMenuItems } from '../components/DisplaySettingsMenuItems'
export { SettingsIcon } from '../components/icons'
export { default as Overlay } from '../components/Overlay'
export {
  BRAND_WORDMARK,
  brandNeedsWordmark,
  currentLocale,
  i18next,
  useTranslation,
} from '../i18n'
export { formatCount, formatDate, formatDateMinute } from '../i18n/format'
export { authenticatedBffFetch } from './authClient'
export { bootstrapClientCapabilities, isClientCapabilityEnabled } from './clientCapabilities'
export { bffBaseUrl, getRuntimeConfig } from './runtimeConfig'
