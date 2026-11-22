DROP TRIGGER IF EXISTS billing_plan_immutable_rights ON billing_plans;
DROP FUNCTION IF EXISTS billing_plan_immutable_rights();
DROP TABLE IF EXISTS billing_purchase_orders;
ALTER TABLE billing_settings DROP COLUMN payments_enabled, DROP COLUMN payment_channel,
 DROP COLUMN receiving_account, DROP COLUMN payment_code_id;
