-- Existing deployments may have applied 0082–0084 before task metering landed.
-- Preserve 0079 for fresh installs; this later migration catches up those deployments.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "metering" jsonb;
