-- Proof that a browser holds a device id, used only by conversation adoption. The device id is
-- self-asserted by the client everywhere else and that stays true; knowing one still lets you read
-- its conversations. Adoption is different: it moves the conversations under an account and the
-- original device never sees them again. One row is written the first time a device id is seen,
-- together with an HttpOnly cookie carrying the token. The row is never rebound, so a device id
-- that leaked through an access log or a shared link cannot be adopted from another browser.
CREATE TABLE "agent_device_claims" (
  "device_id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
