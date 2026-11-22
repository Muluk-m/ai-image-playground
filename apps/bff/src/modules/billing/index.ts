import { Elysia } from 'elysia'
import { isCapabilityEnabled } from '../../lib/capabilities'
import { requireInternalService } from '../../lib/user-auth'
import { orderRoutes } from './order-routes'
import { referralRoutes } from './referral-routes'
import { billingRoutes } from './routes'
import { ensureChatModelPrice, privateTaskHooks, syncModelPricesFromChannels } from './service'

const extensions = new Elysia({ prefix: '/internal/admin' })
  .use(requireInternalService)
  .get('/extensions', () => ({
    navigation: isCapabilityEnabled('billing:credits')
      ? [
          { label: '订单核款', href: '/billing/orders' },
          { label: '计费设置', href: '/billing/settings' },
        ]
      : [],
    user_links: isCapabilityEnabled('billing:credits')
      ? [{ label: '积分与套餐', href_template: '/users/{userId}' }]
      : [],
  }))

export async function initBillingModule(): Promise<void> {
  if (!isCapabilityEnabled('billing:credits')) return
  await syncModelPricesFromChannels()
  await ensureChatModelPrice()
}

export { privateTaskHooks as billingTaskHooks }
export const billingBffRoutes = new Elysia({ name: 'billing-bff-module' })
  .use(extensions)
  .use(billingRoutes)
  .use(orderRoutes)
  .use(referralRoutes)
