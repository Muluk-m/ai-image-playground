-- 升档改为核款后立即生效，订单记 upgrade；降档仍是到期后生效的 schedule。
ALTER TABLE billing_purchase_orders DROP CONSTRAINT billing_orders_subscription_action;
--> statement-breakpoint
ALTER TABLE billing_purchase_orders
 ADD CONSTRAINT billing_orders_subscription_action CHECK (
  subscription_action IS NULL OR subscription_action IN ('grant', 'renew', 'upgrade', 'schedule')
 );
