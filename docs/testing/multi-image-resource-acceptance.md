# Multi-image resource acceptance

## Controlled BFF measurements

Measured on macmini2 with Bun 1.3.14, PostgreSQL 17, real media reservation/completion and Agent HTTP route handling. Disk-backed object storage and model transport are controlled fixtures. Each run contains 100 unique JPEG originals and 100 matching PNG masks, upload concurrency 2, completion concurrency 1. These single samples characterize intake and request preparation; they do not establish production throughput or provider comparison quality.

| Profile | Original bytes | Mask bytes | Upload | Send acceptance | Message JSON | Largest model body | Peak BFF RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2048 × 2048 | 325,125,912 | 4,220,589 | 17.52 s | 1.85 s | 21,925 B | 51,846 B | 549,404,672 B |
| 4096 × 4096 | 1,300,422,749 | 15,461,174 | 26.98 s | 6.62 s | 21,925 B | 51,846 B | 966,295,552 B |

Both runs retained 100 ordered logical references and 200 distinct original/mask identities. Preparation performed 200 object reads with peak read concurrency 1. Each mock model received one bounded acknowledgement request; it did not inspect all 100 images. Send acceptance stayed below the existing 30-second client deadline. RSS was sampled every 20 ms; baseline RSS was 160,350,208 B and 164,675,584 B respectively.

The 4096 profile required both attachment and existing asset byte limits to permit 20 MB; otherwise complete correctly rejected it. Test quotas also allowed 2 GB user media, 16,777,216 pixels per image and a one-hour unsent lease. These are test inputs, not production settings or supplier guarantees.

## Release acceptance still required

- Real browser intake, ordered previews, bounded renderer memory, failure/retry/removal and refresh recovery.
- 99 ready plus one failed must prevent silent partial sending; retry must reuse the 99 accepted originals.
- Repeated send-accept samples before claiming percentiles, and the effective production channel request budgets/compatibility.
- Batch execution and analysis coverage acceptance separately from attachment intake.

`agent:bulk-attachments` remains off by default. Enable only after the configured channel and resource limits pass acceptance; the logical 100-image allowance does not increase the number of images allowed in one model or generation request.
