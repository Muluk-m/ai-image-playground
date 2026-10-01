# Preserve unresolved upstream work for reconciliation

Generation tasks created by a new server-side producer may opt in with
`createQueueTask({ reconciliationRequired: true, ... })`. The public submit schema does not
accept this option. Existing rows keep `false`; this migration does not reinterpret historical
failures and does not enable batch producers.

Opted-in image producers require explicit user retries for definite failures; the old automatic
retry policy stays with legacy producers. Video producers cannot opt in to this image lifecycle.

An opted-in dispatched request whose result is unknown enters nonterminal `reconciling`.
Its hold, task input and upstream evidence remain attached to the original task. Cancellation,
conversation deletion, expired leases, maintenance and ordinary queue claims cannot release
that hold or dispatch a replacement. A dispatch intent is committed before transport starts;
transport-start and available provider request IDs are separate facts. A crash between the
intent and the transport remains ambiguous, never proof that the provider did not run.

Operators query existing upstream task IDs before resolving the task. A short transaction claims
the task with a token and renewable lease. Lookup and archival run without holding a database
connection; a final transaction verifies that lease before recording a decision and settlement.
Each lease writes to an independent output prefix, so an expired operator cannot overwrite a
successor’s result. Providers without a
queryable task require an explicit evidence-backed decision. Every decision identifies the
operator and a command ID, and atomically records the outcome with the existing settlement
contract. Success requires real deliverable results and the normal archival/publication path.
An unsupported lookup, timeout, partial unknown fan-out or missing evidence leaves the hold
untouched. Repeating a decision cannot produce another settlement.

Disable producers before rollback. As long as an opted-in task is queued, executing or awaiting
reconciliation, only binaries that understand its state may run. The down migration rejects
such a rollback rather than converting unknown results into failures.
