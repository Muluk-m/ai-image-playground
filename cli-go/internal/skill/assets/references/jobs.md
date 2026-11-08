# Jobs

- Statuses: `queued` → `running` → `persisting` (result saved, finishing up) → `succeeded`, or `failed` / `canceled`. `terminal: true` means it will not change again.
- `muvloom jobs wait JOB_ID --timeout 300` polls at the server's pace and returns when the job ends or the timeout passes. A timeout is not a failure (`wait_timed_out: true`); the job keeps running. Continue waiting on that same job until terminal unless the user requested background submission; never create a replacement because a wait timed out. A job that ends as `failed` or `canceled` exits with code 4 (`JOB_FAILED` / `JOB_CANCELED`) and the job follows in the error details (`error.details.job` with `--json`).
- A succeeded job lists `artifacts`; download each with `muvloom artifacts download ARTIFACT_ID --output PATH`. Download links are short-lived and fetched fresh each time; a failed download does not affect the job. Do not generate the image again to fix a download.
- Once `images create` has been accepted, any later failure (waiting, or one of several downloads) still carries `job_id` and `idempotency_key` in its details, plus `downloads` for the files already saved and `failed_artifact_id`. Rerun the same `images create` command passing that `idempotency_key` as `--idempotency-key` (a generated key is not reused unless you pass it): it returns the same job without charging again. Every result is fetched again, but a file already saved with the same bytes is not rewritten and is reported with `already_present: true`. A target holding different bytes is still `FILE_EXISTS` with its `path`; choose another `--download` directory, never delete the user's file.
- `actual_credits` on a finished job is what was charged. Failed and canceled jobs are refunded automatically.

## Lost submission

Choose and keep the idempotency key before `images create`, and pass it as `--idempotency-key KEY`. The CLI also records it locally and retries temporary submit failures with the same key. Even a later wait or download can fail after the server accepted the image request: an error does not mean no job exists. Recover with `muvloom jobs list --idempotency-key KEY`, then wait on the existing job or download its artifacts. Re-running `images create` with that key and the same parameters returns the original job instead of creating another.

If resuming an older session without its key or job ID, inspect `muvloom jobs list` for the matching model and submission time. Resume only a uniquely identifiable job; report ambiguity rather than risk a duplicate submission.

## Cancel

Only when the user asks: `muvloom jobs cancel JOB_ID`. Queued and running jobs stop and are refunded. A `persisting` job cannot be canceled (`JOB_NOT_CANCELLABLE`): the image already exists and is being saved.
