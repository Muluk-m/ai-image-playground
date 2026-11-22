-- Destructive rollback for an empty/new commercial deployment only.
DROP TABLE IF EXISTS "billing_credit_ledger";
DROP TABLE IF EXISTS "billing_task_holds";
DROP TABLE IF EXISTS "billing_subscriptions";
DROP TABLE IF EXISTS "billing_credit_accounts";
DROP TABLE IF EXISTS "billing_settings";
DROP TABLE IF EXISTS "billing_plan_prices";
DROP TABLE IF EXISTS "billing_plans";
DROP TABLE IF EXISTS "billing_model_prices";
DROP SCHEMA IF EXISTS "private_billing" CASCADE;
