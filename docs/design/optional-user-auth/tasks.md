# Tasks

> [!IMPORTANT]
> **Superseded historical checklist. Do not repeat these tasks.** The checked items describe the
> temporary issue #26 implementation. Issues #29–#31 replaced its deployment switch, SQLite
> persistence, runtime capability publication, and direct Admin writes. Current contracts:
> [`CONTEXT.md`](../../../CONTEXT.md) and
> [ADR 0001](../../adr/0001-capability-config-fails-closed.md).

## 1. Runtime contract

- [x] Add `auth.enabled` to the shared runtime schema and baked defaults.
- [x] Emit it from the Docker entrypoint.
- [x] Test parsing, fallback, and the disabled default.

Verification: shared/Web typecheck and runtime config tests pass.

## 2. Database

- [x] Add `users`, `user_sessions`, and nullable `tasks.user_id` to Drizzle.
- [x] Add idempotent in-place migrations and indexes.
- [x] Test fresh creation, legacy upgrade, and repeat execution.

Verification: `packages/db` tests pass against fresh and legacy SQLite files.

## 3. BFF authentication and authorization

- [x] Parse `AUTH_ENABLED`.
- [x] Implement password/session primitives and login rate limiting.
- [x] Add login, logout, and current-user routes.
- [x] Require authentication on channel and queue routes when enabled.
- [x] Store task ownership and enforce it on every task endpoint.
- [x] Add auth-disabled compatibility and cross-user isolation tests.

Verification: BFF route tests cover anonymous mode, login mode, disabled users,
foreign task IDs, and cookie attributes.

## 4. Web login gate

- [x] Add credentialed BFF fetch behavior.
- [x] Defer protected channel discovery until the session is known.
- [x] Add login, checking, configuration-error, and expired-session states.
- [x] Add current-account and logout controls to the header.
- [x] Test login behavior and credentialed requests.

Verification: Web tests pass and browser QA covers login failure, login success,
reload persistence, logout, and the auth-disabled page.

## 5. Admin user management

- [x] Add protected user-management endpoints.
- [x] Add API client methods and query/mutation hooks.
- [x] Add Users navigation, list, create dialog, status actions, password reset,
      and session revocation.
- [x] Test API authorization, validation, and state transitions.

Verification: Admin server/client tests pass and browser QA confirms all actions.

## 6. Operations and delivery

- [x] Document environment variables and two-deployment examples.
- [x] Update the BFF security documentation.
- [x] Run Biome write/check, typecheck, and all tests.
- [x] Run simplification/security review and resolve findings.
- [x] Run real browser verification and inspect screenshots.

Verification: all local gates are green and no unrelated files are staged.
