import { registerBuiltInBffOverlayLoader } from '../lib/private-overlay'

/**
 * 组合根注册内置计费与身份模块：
 * `lib/private-overlay.ts` 不反向导入 `modules/*`，由入口（app.ts / worker-index.ts）在启动期注册。
 * 惰性 import 保证未启用或单测 mock `private-overlay` 时不提前求值数据库与计费模块。
 */
registerBuiltInBffOverlayLoader(async () => {
  const [{ billingBffRoutes, billingTaskHooks, initBillingModule }, { feishuProvider }] =
    await Promise.all([import('../modules/billing'), import('../modules/identity')])
  await initBillingModule()
  return {
    routes: billingBffRoutes,
    taskHooks: billingTaskHooks,
    oauthProviders: [feishuProvider],
  }
})
