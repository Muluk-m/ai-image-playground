# Tasks

## 1. Runtime contract

- [ ] Add `auth.enabled` to the shared runtime schema and baked defaults.
- [ ] Emit it from the Docker entrypoint.
- [ ] Test parsing, fallback, and the disabled default.

Verification: shared/Web typecheck and runtime config tests pass.

## 2. Database

- [ ] Add `users`, `user_sessions`, and nullable `tasks.user_id` to Drizzle.
- [ ] Add idempotent in-place migrations and indexes.
- [ ] Test fresh creation, legacy upgrade, and repeat execution.

Verification: `packages/db` tests pass against fresh and legacy SQLite files.

## 3. BFF authentication and authorization

- [ ] Parse `AUTH_ENABLED`.
- [ ] Implement password/session primitives and login rate limiting.
- [ ] Add login, logout, and current-user routes.
- [ ] Require authentication on channel and queue routes when enabled.
- [ ] Store task ownership and enforce it on every task endpoint.
- [ ] Add auth-disabled compatibility and cross-user isolation tests.

Verification: BFF route tests cover anonymous mode, login mode, disabled users,
foreign task IDs, and cookie attributes.

## 4. Web login gate

- [ ] Add credentialed BFF fetch behavior.
- [ ] Defer protected channel discovery until the session is known.
- [ ] Add login, checking, configuration-error, and expired-session states.
- [ ] Add current-account and logout controls to the header.
- [ ] Test login behavior and credentialed requests.

Verification: Web tests pass and browser QA covers login failure, login success,
reload persistence, logout, and the auth-disabled page.

## 5. Admin user management

- [ ] Add protected user-management endpoints.
- [ ] Add API client methods and query/mutation hooks.
- [ ] Add Users navigation, list, create dialog, status actions, password reset,
      and session revocation.
- [ ] Test API authorization, validation, and state transitions.

Verification: Admin server/client tests pass and browser QA confirms all actions.

## 6. Operations and delivery

- [ ] Document environment variables and two-deployment examples.
- [ ] Update the BFF security documentation.
- [ ] Run Biome write/check, typecheck, and all tests.
- [ ] Run simplification/security review and resolve findings.
- [ ] Run real browser verification and inspect screenshots.

Verification: all local gates are green and no unrelated files are staged.

