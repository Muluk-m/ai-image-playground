ALTER TABLE billing_subscriptions
 ADD COLUMN scheduled_plan_id text REFERENCES billing_plans(id),
 ADD COLUMN scheduled_period_months integer,
 ADD COLUMN scheduled_effective_at timestamptz,
 ADD COLUMN scheduled_order_id text;
--> statement-breakpoint
ALTER TABLE billing_subscriptions
 ADD CONSTRAINT billing_subscriptions_scheduled_change CHECK (
  (
   scheduled_plan_id IS NULL
   AND scheduled_period_months IS NULL
   AND scheduled_effective_at IS NULL
   AND scheduled_order_id IS NULL
  )
  OR (
   scheduled_plan_id IS NOT NULL
   AND scheduled_period_months IN (1, 3, 12)
   AND scheduled_effective_at IS NOT NULL
   AND scheduled_order_id IS NOT NULL
  )
 );
--> statement-breakpoint
CREATE UNIQUE INDEX billing_subscriptions_scheduled_order
 ON billing_subscriptions (scheduled_order_id)
 WHERE scheduled_order_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE billing_purchase_orders ADD COLUMN subscription_action text;
--> statement-breakpoint
ALTER TABLE billing_purchase_orders
 ADD CONSTRAINT billing_orders_subscription_action CHECK (
  subscription_action IS NULL OR subscription_action IN ('grant', 'renew', 'schedule')
 );
