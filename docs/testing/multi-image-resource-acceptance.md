# Multi-image resource acceptance

## Controlled BFF measurements

Measured on macmini2 with Bun 1.3.14, PostgreSQL 17, real media reservation/completion and Agent HTTP route handling. Disk-backed object storage and model transport are controlled fixtures. Each run contains 100 unique JPEG originals and 100 matching PNG masks, upload concurrency 2, completion concurrency 1. These single samples characterize intake and request preparation; they do not establish production throughput or provider comparison quality.

| Profile | Original bytes | Mask bytes | Upload | Send acceptance | Message JSON | Largest model body | Peak BFF RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2048 × 2048 | 325,125,912 | 4,220,589 | 17.52 s | 1.85 s | 21,925 B | 51,846 B | 549,404,672 B |
| 4096 × 4096 | 1,300,422,749 | 15,461,174 | 26.98 s | 6.62 s | 21,925 B | 51,846 B | 966,295,552 B |

Both runs retained 100 ordered logical references and 200 distinct original/mask identities. Preparation performed 200 object reads with peak read concurrency 1. Each mock model received one bounded acknowledgement request; it did not inspect all 100 images. Send acceptance stayed below the existing 30-second client deadline. RSS was sampled every 20 ms; baseline RSS was 160,350,208 B and 164,675,584 B respectively.

The 4096 profile required both attachment and existing asset byte limits to permit 20 MB; otherwise complete correctly rejected it. Test quotas also allowed 2 GB user media, 16,777,216 pixels per image and a one-hour unsent lease. These are test inputs, not production settings or supplier guarantees.

## Real browser acceptance

The production Web build was exercised in Chromium against the controlled BFF, real PostgreSQL, and disk-backed media store over an SSH tunnel. The selected files were 100 unique 2048 × 2048 JPEGs (`001.jpg` through `100.jpg`, 325,125,912 original bytes), without masks in this browser run.

- The 74th binary PUT deliberately returned 503. The UI reached 99 ready plus one failed, and sending remained disabled.
- Reloading and choosing the saved-draft restore action retained all 100 ordered inputs and the 99 ready identities. PUT count stayed at 100. Explicitly retrying item 074 brought the count to 101 and all 100 items to ready; the accepted 99 originals were not uploaded again.
- The actual browser turn POST contained 100 references, no base64, and 12,104 UTF-8 bytes. It returned HTTP 200 after 614 ms; one mock model acknowledgement used a 43,419-byte body. The message displayed references 001–100 in order. This acknowledgement did not inspect all image pixels.
- Upload/readiness/recovery used a sampled BFF RSS peak of 401,162,240 bytes from a 231,391,232-byte baseline. Browser JS heap was 52,162,908 bytes before selection; the observed late-intake peak was 236,178,921 bytes, restored-ready heap 127,476,738 bytes, and send-phase peak 167,699,037 bytes. The JS heap is not total renderer memory and sampling began partway through upload, so this is not a complete browser peak bound.
- The browser exposed an attachment-layout overflow at 100 items. The attachment area now scrolls within a viewport-relative height. At 1272 × 831, controls stayed at y=719; at 390 × 844 they stayed at y=645. Both normal pointer retry and send succeeded.

An initial fixture filename typo (`000.jpg`) produced an explicit unreadable item and was removed before replacing it with `100.jpg`; it was not silently dropped or counted as a successful upload. The fault-injection and final-send results above concern the corrected fixed 100-file scope. Tunnel transfer time is not a production throughput measurement.

## Controlled batch execution

The real PostgreSQL, HTTP intake, task scheduler, worker and reconciliation paths were exercised with mocked upstream transport. The 100-item run used 100 distinct original hashes, a dispatch window of 3 and ordered 17-item cursor pages. Its 237 assertions covered pause during preparation, executor restart, exactly 100 original submissions, 99 settled successes, one unresolved upstream result retaining its hold, idempotent operator reconciliation, and one batch/version wake. The unknown result was not dispatched again. Small fixture PNGs test identity and accounting; this run does not replace the large-image resource measurements above.

A separate three-batch run created nine legitimate queued tasks across two accounts. A single scheduler was limited to three active upstream requests and each account to two. Releasing one transport slot admitted one replacement while preserving both limits. All nine tasks completed with nine distinct submissions and one wake per batch. This verifies this scheduler's global limit and the database-enforced account limit, not a new global limit across multiple scheduler processes.

The concurrency run exposed a real lock cycle between task claim, user-change sequence allocation and the user foreign key. A database regression first reproduced the failure, then passed after the claim retained owner serialization with `NO KEY UPDATE`, allowing the event's foreign-key read. The full 18-case execution-lease suite and the three-batch run passed without task crashes after the change.

Explicit-failure retry, dependency blocking, insufficient-credit pause, authentication pause and model-unavailable pause are covered by the focused execution/retry/authentication suites alongside these scale tests. They are not presented as a single 100-item test combining every fault.

## Real browser batch control

A production Web build against the controlled PostgreSQL fixture showed 100 items in five 20-item pages. Confirming admitted three tasks, pausing kept the count at three after those completed, and reloading retained the paused state, page 5 and 21 settled test credits. Resuming reached 98 successes, one definite failure and one unknown outcome without a final wake. Selecting only the definite failure quoted seven credits and created exactly one new attempt after explicit confirmation. The unknown item offered no retry selection.

After that retry, 101 generation submissions and reservations produced 99 successes and 693 settled test credits. Two identical audited reconciliation commands for the unknown attempt yielded one consumed batch/version notice and one additional Agent turn (three model calls total). Reloading displayed the final summary without adding a generation call, reservation or model call. A final rerun with Bun 1.4.2 (matching the production runtime) and the current Web build displayed the final summary automatically while the conversation remained open, without reload or another user message. It retained exactly 101 generation calls/reservations, 693 settled test credits, three model calls and one consumed notice for version 2. The browser selected and confirmed only failed item 017; the unknown outcome was reconciled through the audited fixture endpoint. The screenshot `final-live-bun142.png` records that live summary. API cursor pages were `[17,17,17,17,17,15]`, with 100 distinct items. The UI's attempt counter was corrected from an invalid `101 / 100` ratio to a cumulative submission count.

The first fixture startup lacked a project binding, so the fixture conversation was bound through the real project API before browser execution. The reusable fixture now creates and binds the project before planning. Tiny distinct-color images and mocked upstream prices establish control and accounting behavior, not production generation quality or large-image throughput.

## Real provider small-image analysis

On 2026-10-02 (Asia/Shanghai), the candidate source mirror on macmini2 using Bun 1.3.14 completed one real `gpt-5.6-luna` analysis through the configured OpenAI-compatible gateway. Run `muq0m4xf_9a81e105` used two 512 × 512 synthetic originals: a red square with a white 7 and a blue circle with a white 3. The model identified both colors, shapes and digits correctly and compared them. The real PostgreSQL task completed, the batch closed, and HTTP reads returned both findings with preview evidence and no missing image IDs.

| Evidence | Observed |
| --- | ---: |
| Real analysis HTTP requests / retries | 1 / 0 |
| Final serialized request body | 13,053 B |
| Visual blocks | 2 |
| Reported input / output tokens | 756 / 141 |
| Configured maximum output tokens | 1,024 |
| Time to response headers | 6,261 ms |
| Holds / task ledger entries / generation tasks or archives | 0 / 0 / 0 |
| Reserved / actual user credits | 0 / 0 |

The preceding preparation run `muq0kvvr_762e7986` completed media upload, quotation and confirmation with zero provider dispatches. The live run used the current private billing hooks and an isolated price catalogue with `chat-free` enabled: independent task, attempt, quote and known usage were retained, while the exemption correctly avoided a hold or user charge. This verifies the exemption path, not production catalogue rates or non-exempt settlement.

The fixed human-authored plan called the production plan-creation function; no model planner was mocked or invoked. Upload reservation/completion, binary PUT and confirmation used real HTTP, but the isolated object service ran on loopback rather than R2. The session was issued for a synthetic test account. No ordinary chat call, aggregate wake pickup, image generation or retry was executed. These boundaries exclude natural-language planning, production login, cloud storage and full 100-image model analysis from this result.

The successful body was 13,053 bytes. Neither the probe's 1 MiB application guard nor the proposed 16 MiB production guard was exercised at its limit; this sample does not establish either gateway limit. Raw evidence is retained under `.scratch/provider-compat/runs/<runId>/evidence.json`. Its Git revision fields come from an rsync mirror and are not a reliable source revision; preserve the run evidence with the candidate source snapshot. Final database and execution regressions were subsequently repeated under Bun 1.4.2 to match production. This provider sample predates the final read-only pagination transaction fix and the explicit joint-comparison result contract. It verifies two-image inspection; the model's comparative wording alone does not verify the new structured joint-comparison completion gate.

## Release acceptance still required

- Repeated send-accept samples before claiming percentiles, full browser-process memory measurement, and effective production channel request budgets/compatibility.
- Batch execution and analysis coverage acceptance separately from attachment intake.

`agent:bulk-attachments` remains off by default. Enable only after the configured channel and resource limits pass acceptance; the logical 100-image allowance does not increase the number of images allowed in one model or generation request.
