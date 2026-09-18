DROP TABLE "api_minutes";
--> statement-breakpoint
DROP TABLE "container_samples";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "booted_at";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "swap_free_bytes";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "swap_total_bytes";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "load_15";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "load_5";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "load_1";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "cpu_busy_ratio";
--> statement-breakpoint
ALTER TABLE "host_samples" DROP COLUMN "cpu_count";
