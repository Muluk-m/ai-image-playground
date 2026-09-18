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
