# Optional user authentication

## Why

The project is deployed as two independent instances:

- a personal instance that must preserve the current anonymous workflow;
- a commercial instance that must require managed user accounts before users can
  discover built-in channels or consume BFF generation capacity.

The commercial instance also needs an account identity on every task so a later
change can enforce image quotas per account instead of per browser device.

## What changes

- Add an `AUTH_ENABLED` deployment switch. It defaults to `false`.
- Publish the switch to the Web app through `runtime-config.json`.
- Add username/password users and revocable opaque sessions to the shared SQLite
  database.
- Require an active user session on BFF channel and queue routes when auth is
  enabled.
- Record the authenticated `user_id` on newly submitted tasks and enforce task
  ownership on status, result, image, and cancel routes.
- Add a Web login gate and account/logout affordance.
- Add user creation, enable/disable, password reset, and session revocation to
  the existing Admin application.
- Keep public registration out of scope. Administrators provision accounts.

## Capabilities

### Personal deployment compatibility

With `AUTH_ENABLED=false`, the Web and BFF retain their existing anonymous
behavior and existing rows remain readable.

### Commercial login

With `AUTH_ENABLED=true`, an active account and valid HttpOnly session cookie are
required before the application or queue API can be used.

### Account administration

An authenticated administrator can create accounts, disable or re-enable them,
reset passwords, and revoke active sessions. Accounts are disabled rather than
deleted so task ownership and audit history remain intact.

### Future account quota

Every authenticated submission stores `tasks.user_id`. This change does not yet
replace the current device quota, but it creates the stable identity required by
the future quota implementation.
