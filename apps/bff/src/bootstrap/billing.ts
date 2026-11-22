import { registerBuiltInBffOverlayLoader } from '../lib/private-overlay'
import { billingBffRoutes, billingTaskHooks, initBillingModule } from '../modules/billing'
import { feishuProvider } from '../modules/identity'

/**
 * 组合根注册内置计费与身份模块：
 * `lib/private-overlay.ts` 不反向导入 `modules/*`，由入口（app.ts / worker-index.ts）在启动期注册。
 */
registerBuiltInBffOverlayLoader(async () => {
  await initBillingModule()
  return {
    routes: billingBffRoutes,
    taskHooks: billingTaskHooks,
    oauthProviders: [feishuProvider],
  }
})
