-- 回滚 0111_drop_user_asset_objects.sql：
-- 重建 public.user_asset_objects（含原始主键与外键约束），并将 media_objects 中同步素材对象回同步。

CREATE TABLE IF NOT EXISTS "public"."user_asset_objects" (
	"user_id" text NOT NULL,
	"image_id" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_asset_objects_user_id_image_id_pk" PRIMARY KEY("user_id","image_id")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_asset_objects_user_id_users_id_fk'
      AND conrelid = 'public.user_asset_objects'::regclass
  ) THEN
    ALTER TABLE "public"."user_asset_objects"
      ADD CONSTRAINT "user_asset_objects_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO public.user_asset_objects (user_id, image_id, bytes, content_type, created_at)
SELECT user_id, asset_image_id, bytes::integer, content_type, created_at
FROM public.media_objects
WHERE asset_image_id IS NOT NULL
  AND status <> 'deleting'
  AND bytes <= 2147483647
ON CONFLICT (user_id, image_id) DO NOTHING;
