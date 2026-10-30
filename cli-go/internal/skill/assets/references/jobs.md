# Jobs

Use `muvloom jobs list` to inspect jobs, `muvloom jobs get <job_id>` to inspect one job, and `muvloom jobs cancel <job_id>` only when the user explicitly asks to cancel. Follow the status returned by the service and avoid assuming completion timing. Preserve an idempotency key when retrying a create request.

Do not poll indefinitely or invent a timeout; use the CLI/API response and report a pending status when the service does not provide completion.
