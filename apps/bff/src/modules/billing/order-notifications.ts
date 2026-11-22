import { purchaseOrders } from '@image-playground/db/billing'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/client'

/** Worker-only maintenance: claiming is permanent, including uncertain network outcomes. */
export async function notifyNewOrders(now = Date.now()) {
  await db
    .update(purchaseOrders)
    .set({ notification_status: 'unknown' })
    .where(
      and(
        eq(purchaseOrders.notification_status, 'claimed'),
        lt(purchaseOrders.notification_at, now - 5 * 60_000),
      ),
    )
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.notification_status, 'pending'))
      .limit(20)
      .for('update', { skipLocked: true })
    for (const row of rows)
      await tx
        .update(purchaseOrders)
        .set({ notification_status: 'claimed', notification_at: now })
        .where(eq(purchaseOrders.id, row.id))
    return rows
  })
  await Promise.all(
    claimed.map(async (row) => {
      let outcome: 'sent' | 'failed' | 'unknown' = 'failed'
      const webhook = process.env.OPS_ALERT_WEBHOOK_URL?.trim()
      const origin = process.env.ADMIN_FRONTEND_ORIGIN?.trim()
      if (webhook && origin) {
        try {
          const url = new URL(`/billing/orders?order=${encodeURIComponent(row.id)}`, origin).href
          const response = await fetch(webhook, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              msg_type: 'interactive',
              card: {
                header: {
                  title: { tag: 'plain_text', content: '有新的付款请求' },
                  template: 'blue',
                },
                elements: [
                  { tag: 'div', text: { tag: 'plain_text', content: `订单号：${row.id}` } },
                  {
                    tag: 'action',
                    actions: [
                      {
                        tag: 'button',
                        text: { tag: 'plain_text', content: '前往 Admin 核款' },
                        url,
                        type: 'primary',
                      },
                    ],
                  },
                ],
              },
            }),
          })
          if (!response.ok) outcome = 'failed'
          else {
            const result = await response.json()
            outcome = result.code === 0 || result.StatusCode === 0 ? 'sent' : 'failed'
          }
        } catch {
          outcome = 'unknown'
        }
      }
      await db
        .update(purchaseOrders)
        .set({ notification_status: outcome, notification_at: Date.now() })
        .where(
          and(eq(purchaseOrders.id, row.id), eq(purchaseOrders.notification_status, 'claimed')),
        )
    }),
  )
}
