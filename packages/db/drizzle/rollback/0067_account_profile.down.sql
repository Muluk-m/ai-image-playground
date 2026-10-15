ALTER TABLE "user_sessions" DROP COLUMN "last_active_at";
ALTER TABLE "user_sessions" DROP COLUMN "ip";
ALTER TABLE "user_sessions" DROP COLUMN "user_agent";
ALTER TABLE "users" DROP CONSTRAINT "users_bio_check";
ALTER TABLE "users" DROP CONSTRAINT "users_nickname_check";
ALTER TABLE "users" DROP COLUMN "avatar_key";
ALTER TABLE "users" DROP COLUMN "bio";
ALTER TABLE "users" DROP COLUMN "nickname";
