-- Keep financial records intact: downgrade only when no recharge orders exist.
BEGIN;
LOCK TABLE billing_purchase_orders IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM billing_purchase_orders WHERE kind = 'recharge') THEN
  RAISE EXCEPTION 'Cannot downgrade while recharge orders exist; retain schema and reconcile first';
 END IF;
END $$;
ALTER TABLE billing_purchase_orders DROP CONSTRAINT billing_order_kind_shape,
 ALTER COLUMN plan_id SET NOT NULL, ALTER COLUMN plan_name SET NOT NULL,
 ALTER COLUMN period_months SET NOT NULL, DROP COLUMN recharge_credits, DROP COLUMN kind;
COMMIT;
