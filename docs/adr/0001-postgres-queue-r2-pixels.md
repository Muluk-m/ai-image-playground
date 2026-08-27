# Queue metadata in Postgres, pixels in R2

The BFF, worker, and admin need a shared store once they leave the Mac mini SQLite file. Queue rows and daily quota go in the existing Postgres cluster. Image bytes stay out of that cluster (WAL and backups) and go to the existing Cloudflare R2 bucket `ai-images`, under prefix `image-playground/`, with a 7-day lifecycle scoped to that prefix only. The browser still loads pixels through `GET /v1/queue/requests/{id}/image/{index}`; the BFF proxies R2. New environments start with an empty Postgres; sqlite is not migrated.

**Considered:** SQLite on a TKE PVC (cannot share safely across API + worker + admin, no HA path); Postgres `bytea` (works, pollutes the shared cluster); Tencent COS (extra vendor next to Cloudflare); a new R2 bucket (unnecessary — `ai-images` already exists).
