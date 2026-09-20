# Domain cutover

Browser data is copied directly from the source origin's `/local-compat.html` through a
checked-origin MessageChannel before the application opens IndexedDB. Each acknowledgement
follows a committed destination transaction. Source databases are never deleted. Existing
conflicts are backed up locally; an ambiguous empty destination canvas does not qualify as
completed migration. Restricted browsers and unresolved imports return to the source URL
with `__legacy=1` rather than showing an empty destination workspace.

Login continuity uses top-level HTTPS API navigations, because the source's SameSite=Lax
session cookie cannot be read inside a cross-site iframe. Both API hosts must reach the same
BFF process and database. Set `DOMAIN_HANDOFF_CONFIG_FILE` to a mounted JSON file containing
`sourceOrigin`, `targetOrigin`, `sourceApiOrigin`, and `targetApiOrigin` (bare HTTPS origins).
The configuration is validated at startup; without it the handoff is disabled.

The target API binds a two-minute, single-use exchange to an HttpOnly cookie. The source API
identifies its existing session; the target API revalidates the active user and unexpired
source session, creates a new session capped to the source expiry, and issues its normal
HttpOnly cookie. Existing target accounts are preserved. No cookie credential or browser
storage payload is handed to frontend JavaScript. Only temporary authentication metadata
is held in process memory; a restart returns the user to the old site. A separate short-lived
HttpOnly completion receipt prevents query parameters from pretending the exchange succeeded.

Deploy the BFF and configuration before the frontend. Keep the per-origin API mapping so
source fallback still uses the source API and its cookies. The frontend records successful
handoff once; it must not silently sign the user back in after an intentional logout.

## Redirect rollout

Start with a temporary 302 for source **frontend document paths only** (`/`, `/index.html`,
`/p/*`), preserving path and query. Exclude requests whose query contains `__legacy=1`.
Leave `/local-compat.html`, `/assets/*`, runtime config, all other resources, and the old API
outside this rule. Validate successful import/login and failed-import fallback before
changing the status to 301. Retain source DNS, HTTPS, Pages and API service: users who have
not returned yet still need their original browser origin.

To roll back, disable only this redirect rule. No data deletion or database migration is
part of this cutover. A generic all-path redirect or removal of the source site breaks
recovery and is unsafe even after most active users have moved.
