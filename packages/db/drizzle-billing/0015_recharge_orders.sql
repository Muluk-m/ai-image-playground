ALTER TABLE billing_purchase_orders
 ADD COLUMN kind text NOT NULL DEFAULT 'subscription',
 ADD COLUMN recharge_credits integer,
 ALTER COLUMN plan_id DROP NOT NULL,
 ALTER COLUMN plan_name DROP NOT NULL,
 ALTER COLUMN period_months DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE billing_purchase_orders ADD CONSTRAINT billing_order_kind_shape CHECK (
 (kind = 'subscription' AND plan_id IS NOT NULL AND plan_name IS NOT NULL AND period_months IS NOT NULL AND recharge_credits IS NULL)
 OR (kind = 'recharge' AND plan_id IS NULL AND plan_name IS NULL AND period_months IS NULL AND recharge_credits IS NOT NULL AND recharge_credits > 0)
);
