ALTER TABLE billing_settings ADD COLUMN payments_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN payment_channel text NOT NULL DEFAULT 'wechat',
 ADD COLUMN receiving_account text NOT NULL DEFAULT '',
 ADD COLUMN payment_code_id text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE billing_purchase_orders (
 id text PRIMARY KEY, code text NOT NULL UNIQUE, request_id text NOT NULL,
 user_id text NOT NULL REFERENCES users(id), plan_id text NOT NULL REFERENCES billing_plans(id),
 plan_name text NOT NULL, period_months integer NOT NULL CHECK(period_months IN(1,3,12)),
 amount_cents integer NOT NULL CHECK(amount_cents > 0 AND amount_cents % 100 = 0),
 status text NOT NULL CHECK(status IN('pending','review','completed','rejected','cancelled','expired')),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 claimed_at timestamptz, completed_at timestamptz, starts_at timestamptz, ends_at timestamptz,
 review_note text NOT NULL DEFAULT '',
  rejection_message text NOT NULL DEFAULT '', payment_code jsonb NOT NULL,
 payment_history jsonb NOT NULL DEFAULT '[]', receipt jsonb,
 receipt_channel text, receipt_account text, receipt_transaction text,
 history jsonb NOT NULL DEFAULT '[]',
 notification_status text NOT NULL DEFAULT 'pending' CHECK(notification_status IN('none','pending','claimed','sent','failed','unknown')),
 notification_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_orders_user_request ON billing_purchase_orders(user_id,request_id);
CREATE INDEX billing_orders_status_time ON billing_purchase_orders(status,created_at);
CREATE UNIQUE INDEX billing_orders_receipt_unique ON billing_purchase_orders
 (receipt_channel,receipt_account,receipt_transaction) WHERE receipt_transaction IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION billing_plan_immutable_rights() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.monthly_credits IS DISTINCT FROM NEW.monthly_credits OR OLD.max_concurrent_tasks IS DISTINCT FROM NEW.max_concurrent_tasks THEN
  RAISE EXCEPTION 'plan_entitlements_immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER billing_plan_immutable_rights BEFORE UPDATE ON billing_plans
 FOR EACH ROW EXECUTE FUNCTION billing_plan_immutable_rights();
