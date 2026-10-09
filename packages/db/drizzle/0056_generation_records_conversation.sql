CREATE INDEX "idx_generation_records_conversation" ON "generation_records" ("user_id", ("source" ->> 'conversationId'), "created_at" DESC) WHERE "deleted_at" IS NULL;
