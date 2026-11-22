-- 已完成的升档订单回滚后按换档展示；订阅本身已立即切档，不受影响。
UPDATE billing_purchase_orders SET subscription_action = 'schedule' WHERE subscription_action = 'upgrade';
ALTER TABLE billing_purchase_orders DROP CONSTRAINT billing_orders_subscription_action;
ALTER TABLE billing_purchase_orders
 ADD CONSTRAINT billing_orders_subscription_action CHECK (
  subscription_action IS NULL OR subscription_action IN ('grant', 'renew', 'schedule')
 );
