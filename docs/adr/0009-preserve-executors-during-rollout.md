# Preserve execution owners during deployment

## Decision

A release admits new work on the new version and drains the old version without interrupting its work. A deployment timeout means **retain the old instance and report an incomplete drain**, never cancel its tasks or regenerate them. Queue jobs and agent conversations both count, including asynchronous admission and finalization.

Queue execution claims carry a unique fencing token and renewable lease. Recovery may poll persisted upstream task IDs, including one bounded final lookup after the original deadline. A lost executor that has dispatched a request without a durable upstream ID leaves an unknown result; it must not automatically resubmit. A stale executor cannot write or settle after its lease has been replaced.

An agent conversation needs durable execution ownership before new versions may share admission. Reconnection, interjection and cancellation must reach the owner. Every model/tool side effect, durable message write and paid settlement revalidates that ownership; paid chat tasks carry the same renewable lease and fencing token. Completed event replay alone is not live continuation. In-memory execution cannot be moved just by rerouting HTTP.

The first rollout is special: the previous binary has neither drain introspection nor execution ownership. Existing conversations must remain routed to that legacy instance until they can be proven idle. An empty paid task table is insufficient proof for the internal edition, where unbilled conversations have no chat task row.

## Consequences

Deployment safety depends on stable ingress, addressable release instances, atomic task claims, backward-compatible migrations and owner-aware routing. Extending Docker's stop timeout is not an implementation of this decision. Crash recovery and normal deployment are separate guarantees: checkpoints may resume only where the outcome of every prior external side effect is known. Durable settlement failure keeps the original executor active and retries there; ownership loss fences the stale executor instead of allowing a second settlement.

Queue status exposes the durable phase (`queued`, `generating`, `reconnecting`, `confirming`) so the browser does not flatten every wait into “generating”. An expired lease becomes reconnecting until the recovery scan either resumes a known upstream task or writes a terminal unknown-result failure.

## Acceptance

Start an image job and agent conversation, switch releases while both are executing, submit new work, reconnect the original turn, and verify all complete with exactly one upstream generation and one settlement. Also test lost executors, lease renewal races, unknown submissions, partial fan-out and a completed upstream result recovered after its original deadline. A failed health check, drain timeout or uncertain legacy activity must preserve the old instance.

## Revision (2026-10-18): bounded retention replaces deadline stops

The 2026-09-18 revision stopped executors after a drain deadline to bound PostgreSQL connections. That policy interrupted live upstream requests whose results could not be recovered from a persisted task ID. Crash recovery cannot make those requests safe to interrupt. This revision replaces every deadline stop, including preflight leftovers, failed candidates and legacy retirement, with the same retirement proof.

An edition has at most its current generation and one retained generation. Docker inventory supplies the retained set, including partial generations and failed candidates. Before migration or candidate creation, a different-image deployment must safely remove every noncurrent executor. Any busy, failed or unknown instance blocks that deployment. A completed cutover can retain the previous generation and still update ancillary services and return success. Retention no longer accumulates a third generation or prevents the other edition from publishing.

`releases/route.json` commits ingress ownership with its BFF origin and paired worker. `current` is a derived compatibility file. Re-entry validates project, role, generation and container identity, repairs `current`, and resumes the worker selected by the route before checking capacity. Missing or malformed routing state with managed executors blocks deployment. Repeating the same immutable BFF and worker image IDs verifies their health and converges admission, retained cleanup and ancillary services without creating another generation.

A running retirement target must acknowledge drain and report boolean `draining=true`, integer `active=0` and boolean `safeToStop=true`. BFFs must also report `failed=false`, including older BFFs whose `safeToStop` omitted that condition. The new worker includes pending private maintenance in its readiness. Older workers retain their existing queue, analysis and batch readiness contract. This first upgrade does not retroactively prove that an older worker counted private maintenance; its shutdown path already waits for that maintenance.

The retirement operation disables automatic restart before drain, removes only that worker's activation marker, and checks the same container ID and process start time before stopping it. Docker or control errors, malformed responses, failed finalization and changed identity retain the instance. A proven idle executor receives a graceful stop followed by plain `docker rm`. A confirmed stopped executor can be removed without a stop. Force removal and deadline-triggered cancellation are prohibited for executors.

The shared drain wait uses elapsed time, including control requests. Its deadline ends further waiting and reports retained instances. It does not cancel their work. Each Docker probe is separately bounded. This revision does not add a general migration watchdog or database lock timeouts.

The router cutover never transfers in-memory ownership. Retained executors keep their names, networks and owner origins, so active Agent reconnection, interjection and cancellation can reach the original BFF. A candidate BFF can already own inbox work before cutover, and a candidate worker resumes before the route commit. Pre-cutover failure therefore restores current admission and retires candidates only through the same safety check. A failure after the route commit preserves the new current generation even if writing `current` failed.

A legacy endpoint without drain introspection remains unknown. The old queue-only database gate cannot prove unbilled Agent inactivity. `DEPLOY_RETIRE_LEGACY=1` grants no exemption, and a legacy executor that needs to be stopped blocks the release until a separately verified retirement is available. The script preserves its `legacy-origin` record while that executor remains.

Accepted cost: a long-running or failed executor can delay a subsequent different-image deployment or rollback. Both operations use the current safe deployment tools. The connection budget remains bounded at two generations per edition, with admin, logging, test, migration and backup connections budgeted separately. No background cleanup service is added; later deployment attempts collect retained instances that have become safe.
