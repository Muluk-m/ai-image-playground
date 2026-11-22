ALTER TABLE "billing_settings"
ALTER COLUMN "guidance"
SET DEFAULT '联系客服完成转账后，请发送用户名与付款截图。';
--> statement-breakpoint
UPDATE "billing_settings"
SET "guidance" = '联系客服完成转账后，请发送用户名与付款截图。'
WHERE "guidance" = '联系客服完成转账后，请发送账号与付款截图。';
