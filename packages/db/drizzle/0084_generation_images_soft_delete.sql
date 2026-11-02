-- 「我的作品」里多图任务可以只删其中一张：单张产出软删，原件与引用留在原地（画布、对话可能还在用）。
ALTER TABLE "generation_images" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
