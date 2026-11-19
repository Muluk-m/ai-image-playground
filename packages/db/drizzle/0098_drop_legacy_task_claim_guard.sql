-- 0029 为 #580 之前的旧执行者加的认领闸门。开关自 #1901 起无人置位，触发器只在每次 tasks 更新上空跑一次加锁查询。
-- DROP TRIGGER 要拿 tasks 的排他锁：等不到就让这次发布失败重试，不让排队的锁把整张表卡住。
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS guard_legacy_task_claim ON tasks;
--> statement-breakpoint
DROP FUNCTION IF EXISTS guard_legacy_task_claim();
--> statement-breakpoint
DROP TABLE IF EXISTS deployment_controls;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
