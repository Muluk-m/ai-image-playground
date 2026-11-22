ALTER TABLE "billing_settings"
ADD COLUMN IF NOT EXISTS "contact_qr_url" text DEFAULT '' NOT NULL;
