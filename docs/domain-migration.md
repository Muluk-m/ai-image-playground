# Brand domain migration

Automatic migration runs before the application opens any persistent storage. The destination creates a browser-held secret, visits the legacy origin at top level, and returns after exporting app-owned IndexedDB/localStorage. Top-level navigation is necessary for legacy SameSite session cookies and first-party storage access; an invisible cross-site iframe cannot provide reliable access.

The source encrypts records in the browser. A short-lived relay holds only ciphertext and a hash-bound handoff, never plaintext API keys or copied cookies. The destination proves possession of its own secret, imports records without overwriting existing destination records, then exchanges the still-valid source session for a new host-only cookie. Conflicting destination accounts do not silently switch identity. Existing keys at the destination win; conflicting source values are also retained in the destination `muvloom-legacy-backup` database. Pending sync IDs are unioned and the sync cursor is reset so restored offline changes are considered; the original source stays intact. Interrupted imports are idempotent and retryable.

The old domain, legacy API and migration bridge path must remain available. A later 301/308 rule must exclude the bridge and its static assets. HTTP 304 is not a redirect. Expired sessions cannot be revived. Storage denial, quota exhaustion, network interruption and account conflicts need an honest recovery state rather than falsely marking migration complete.

Acceptance: existing session survives the origin change; app settings, image blobs, all account scopes, canvas scenes and local history are retained; invite/deep-link query survives; no source deletion; destination collisions are preserved; replay/foreign origins/wrong secret/expired or revoked session rejected; interrupted transfer can retry; deployments without a migration configuration behave unchanged.


## Operator rollout

1. Deploy the migration schema and BFF with `DOMAIN_MIGRATION_CONFIG_FILE` unset. Existing deployments remain unchanged.
2. Publish the frontend to both the source and destination bindings of the existing Pages project.
3. Set `DOMAIN_MIGRATION_CONFIG_FILE=/run/operator/domain-migration.json` on the paid BFF, using the four exact HTTPS origins. Keep source and destination in CORS_ALLOWED_ORIGINS and keep both API Tunnel routes.
4. Verify local images, canvas, settings and an existing source session in a controlled browser. Do not enable a global redirect until this passes.
5. A later redirect may cover old document URLs but must exclude `/__domain-migration`, `/assets/*`, `/runtime-config.json`, `/sw.js`, `/brand/*`, and the old API hostname. The migration endpoint must render the application entry point on the old origin, never redirect to the new origin.

The relay is capped at 512 MiB per migration / 1 GiB overall (base64 ciphertext), 32 live transfers and 10 starts per source IP per hour. Transfers expire after one hour; successful completion immediately deletes all relay rows. Expired transfers are removed on the next start and during task retention maintenance. Disabled/revoked/expired source sessions cannot produce a new session. New session lifetime never exceeds the source session lifetime.

Rollback: disable the configured migration file, restore the prior Pages deployment and origin configuration. Do not drop either domain or browser data. Added database tables are additive and may remain until expired data is purged.
