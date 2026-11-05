-- 回滚只拆掉 refresh 链。user_sessions 里已经签发的 access 行留下来，
-- 在各自的 expires_at 之前继续能登录，避免回滚代码把人踢出去。
DROP INDEX IF EXISTS "idx_user_sessions_family_id";
ALTER TABLE "user_sessions" DROP COLUMN IF EXISTS "family_id";
DROP TABLE IF EXISTS "user_retired_refresh_tokens";
DROP TABLE IF EXISTS "user_session_families";
