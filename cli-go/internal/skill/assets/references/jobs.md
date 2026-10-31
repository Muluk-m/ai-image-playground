# Jobs

- Statuses: `queued` → `running` → `persisting` (result saved, finishing up) → `succeeded`, or `failed` / `canceled`. `terminal: true` means it will not change again.
- `muvloom jobs wait JOB_ID --timeout 300` polls at the server's pace and returns when the job ends or the timeout passes. A timeout is not a failure (`wait_timed_out: true`); the job keeps running and can be checked again later. A job that ends as `failed` or `canceled` exits with code 4 (`JOB_FAILED` / `JOB_CANCELED`) and the job is in `error.details.job`.
- A succeeded job lists `artifacts`; download each with `muvloom artifacts download ARTIFACT_ID --output PATH`. Download links are short-lived and fetched fresh each time; a failed download does not affect the job.
- `actual_credits` on a finished job is what was charged. Failed and canceled jobs are refunded automatically.

## Lost submission

`images create` writes the idempotency key locally before sending and retries temporary failures with the same key. If the command still fails or the session ends, recover with `muvloom jobs list --idempotency-key KEY`. Re-running `images create` with the same `--idempotency-key` and the same parameters returns the original job instead of creating a second one.

## Cancel

Only when the user asks: `muvloom jobs cancel JOB_ID`. Queued and running jobs stop and are refunded. A `persisting` job cannot be canceled (`JOB_NOT_CANCELLABLE`): the image already exists and is being saved.
