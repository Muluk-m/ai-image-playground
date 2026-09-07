CREATE TABLE "user_asset_objects" (
	"user_id" text NOT NULL,
	"image_id" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_asset_objects_user_id_image_id_pk" PRIMARY KEY("user_id","image_id")
);
--> statement-breakpoint
ALTER TABLE "user_asset_objects" ADD CONSTRAINT "user_asset_objects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;