# Design

> [!IMPORTANT]
> **Superseded historical design. Do not use this document as an operations or implementation
> contract.** Issue #30 replaced `AUTH_ENABLED` and client-published authentication switches with
> the fail-closed `accounts:login` capability. Issue #29 replaced SQLite with PostgreSQL, and issue
> #31 moved every operator write through authenticated BFF endpoints. Current contracts:
> [`CONTEXT.md`](../../../CONTEXT.md) and
> [ADR 0001](../../adr/0001-capability-config-fails-closed.md).

## Deployment contract

`AUTH_ENABLED` is evaluated independently by each BFF deployment:

| Deployment | `AUTH_ENABLED` | Behavior |
| --- | --- | --- |
| Personal | `false` or unset | Anonymous behavior remains available |
| Commercial | `true` | Login is required by both Web and BFF |

The Docker entrypoint writes the same value to
`runtime-config.json.auth.enabled`. The runtime value controls UX only; the BFF
environment value is the security boundary.

An auth-enabled Web deployment also requires `bff.enabled=true`. If this
invariant is violated, the Web app shows a configuration error instead of
falling back to anonymous access.

## Data model

### `users`

- `id`: UUID primary key
- `username`: normalized lowercase login identifier, unique
- `password_hash`: Argon2id hash produced by `Bun.password`
- `status`: `active` or `disabled`
- `created_at`, `updated_at`, `last_login_at`

Usernames accept 3-32 ASCII letters, numbers, dots, underscores, and hyphens.
Passwords accept 8-128 characters.

### `user_sessions`

- `token_hash`: SHA-256 hash of a random 256-bit token, primary key
- `user_id`: owning user
- `created_at`, `expires_at`

Only the raw token is sent to the browser. Only its hash is stored. Sessions use
a 30-day sliding-independent lifetime and are revoked explicitly on logout,
password reset, account disable, or the Admin revoke action.

### `tasks.user_id`

Nullable for backward compatibility and anonymous personal deployments. It is
required by application logic for every new submission while auth is enabled.

## Authentication flow

1. Web reads `runtime-config.json`.
2. If auth is disabled, it keeps the current boot flow.
3. If auth is enabled, Web calls `GET /api/auth/me` with credentials.
4. An unauthenticated response renders the login screen.
5. `POST /api/auth/login` verifies the password with Argon2id, creates an opaque
   session, and sets a `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
6. After authentication, Web discovers channels and initializes the workspace.

Login failures are rate-limited independently by source address and normalized
username. They always return the same `invalid_credentials` error for unknown
usernames, wrong passwords, and disabled accounts.

## Authorization boundaries

When auth is enabled, the BFF requires an active user for:

- `GET /api/channels`
- `POST /v1/queue/:provider/:model/submit`
- every `/v1/queue/requests/:id` status/result/image/cancel route

Task reads and mutations include both task ID and authenticated user ID. Missing
and foreign tasks both return 404 to avoid disclosing their existence.

`/health`, the static application, `runtime-config.json`, and
`/api/auth/login` remain public. Logout and `me` operate on the current session.

Protected image responses use private browser caching in auth mode rather than
public shared caching.

## Admin model

The Admin application keeps its independent administrator cookie. Its new user
routes use a bounded read-write database handle while the existing task/device
queries remain `query_only`.

Admin operations:

- list users and active session counts;
- create a user;
- set account status;
- reset password;
- revoke all sessions.

No API returns password hashes or session token hashes.

## Web design direction

The login gate uses a restrained editorial-tool aesthetic consistent with the
existing workspace: ink black, paper white, cobalt accents, a subtle generative
grid, and precise micro-motion. It avoids introducing a second design system.

The Admin user page remains intentionally utilitarian: dense, legible rows with
clear status and destructive-action hierarchy.

## Security decisions

- Server-side enforcement cannot be disabled by manipulating runtime config.
- Password hashes use Bun's default Argon2id parameters.
- Session tokens contain 256 bits of randomness and are stored only as SHA-256.
- Login is rate-limited.
- Cookies are Secure, HttpOnly, SameSite=Lax, and scoped to `/`.
- State-changing endpoints accept JSON and remain protected by same-site cookies
  plus CORS.
- Disabled users fail session resolution immediately.
- Ownership checks are applied to every task endpoint, including binary images.
- User records are disabled, not deleted.

## Compatibility

All new database fields are nullable or introduced in new tables. Existing task
and device quota data migrate in place. The current device-based daily quota
continues to apply in both deployments until the account quota feature is
implemented.
