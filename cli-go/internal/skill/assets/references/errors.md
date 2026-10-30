# Errors

Read the JSON envelope before taking action. `INVALID_REQUEST` (exit 2) means correct the command or ask for missing input. `UNAUTHENTICATED` (exit 3) means complete the device login flow. `FORBIDDEN` (exit 4), `NOT_FOUND` (exit 5), `CONFLICT` (exit 6), and `RATE_LIMITED` (exit 7) are service outcomes to report without retrying blindly. `INTERNAL_ERROR` (exit 1) covers network and unexpected failures.

Never work around an error by sending direct API requests, inventing a model or price, or exposing credentials. Retry only when the service explicitly permits it, preserving idempotency keys for create operations.
