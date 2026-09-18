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

## Superseded in part (2026-09-18): finite drain, then forced stop

"Retain the old instance until it is provably idle, never cancel" is replaced. The production VPS is small, both editions share one PostgreSQL with 100 connections, and we deploy several times a day. Retention without a bound accumulated generations: one wait of up to 30 minutes per rollout, `safeToStop` held false forever by a single failed settlement write, old executors left running when the wait timed out, and ancillary services and the next edition skipped by the resulting non-zero exit. The retained generations exhausted the shared connections, and two paid rollouts failed on 2026-09-18.

The new rule:

- An edition runs at most two generations: the one serving and the one being rolled out. Before a rollout starts, every labelled executor other than the generation named in `releases/current` is stopped and removed without being probed.
- After the cutover the previous generation drains for a hard deadline (default 5 minutes, `DEPLOY_DRAIN_DEADLINE_SECONDS`). Whatever is still active then is stopped (SIGTERM, `DEPLOY_STOP_GRACE_SECONDS` of grace, default 75) and removed. A deadline stop is reported, not a failure; the ancillary services are always updated.
- Interrupted work is recovered by mechanisms that already existed: an expired queue lease resumes polling a persisted upstream task id and never resubmits an unknown dispatch; an expired conversation lease is sealed and the interrupted turn is resumed once (#641). The cut-off chat task's hold is released and the resumed turn is billed once (`forced-stop-recovery.test.ts`).
- A failed durable settlement no longer holds the instance. `failed` is reported by the drain status and the rollout warns; the recovery scan seals the turn once its lease expires.
- Any failure before the cutover removes the instances the rollout created and restores the previous state: drained workers resumed, the legacy claim gate reopened, a replaced router put back.
- The pre-protocol legacy executor is retired once, explicitly, with `DEPLOY_RETIRE_LEGACY=1`: the new generation starts without `LEGACY_EXECUTOR_ORIGIN` and owns generation-0 conversations, and after the cutover the legacy BFF and worker are stopped and removed and `legacy-origin` is deleted. The legacy binary has no drain introspection, so it gets only the stop grace.

Accepted cost: a turn or job still running at the deadline is interrupted and continues through recovery rather than in place. An agent turn's unfinished reply text is lost and resumed once; a stopped executor's model usage for the cut-off turn is not charged.
