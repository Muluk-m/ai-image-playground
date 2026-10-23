# segmenter

Stateless EdgeTAM (Apache-2.0, `onnx-community/EdgeTAM-ONNX` fp16, pinned revision) for the
agent's edit-region proposals. The BFF calls it over the internal Docker network; nothing else does.

- `POST /v1/segment` `{ key, image?, box?, points?, output? }`
  - `key`: cache key for the image (the BFF sends `media:<mediaId>`). If the key is unknown and no
    `image` is given, it answers `404 { error: "image_required" }`, and the BFF retries with the image.
  - `image`: base64 JPEG/PNG, long edge ≤ 1024 (the model works at 1024).
  - `box`: `[x0, y0, x1, y1]`, normalized 0–1. `points`: `[[x, y, 1|0], …]`, normalized; 1 means include, 0 means exclude.
  - `output`: optional `{ width, height }` for the mask size (≤ 4096); defaults to the image size.
  - Returns `{ width, height, masks: [{ score, bits }], timings }`. `bits` is a base64 bitmask,
    row-major, MSB first. Picking a mask, dilation and storage are done by the BFF.
- `GET /health`: whether the model is loaded, the cache size, the queue, and RSS.

Runtime limits:
- One request runs at a time and up to 4 wait; beyond that it answers `503 busy`.
- Each deployment namespace (the BFF sends `namespace`, its project name) holds at most 2 of those
  slots (`SEGMENTER_NAMESPACE_MAX`), so one edition cannot fill the queue for the others. The BFF
  also limits each user to one click in flight and 30 per minute (`429`).
- 2 ORT threads, with the CPU memory arena off.
- The model loads on the first request and is released after 10 minutes idle. Releasing it does
  not give the memory back to the OS: measured on the VPS, the container stays at about 450 MB RSS
  while idle (`/health` reports `loaded: false`, `rssMB` ≈ 450–470), so budget for that.
- Up to 3 image embeddings are cached. The status probe always uses one fixed key per namespace.
- Measured locally on 2 cores: about 360 MB RSS with the model loaded, about 0.4–0.6 s encode, and 0.05–0.09 s per click for decode.
- Container limits: memory and swap 900m, 2 CPUs.

Deployment: ONE shared container, `image-playground-segmenter`, for every edition. It is a base
component with its own version, `deploy/segmenter/VERSION` (a whole number), and is never rebuilt by
an app release:
- Only production releases carry its image (`ai-image-playground:segmenter-<VERSION>-<commit>`,
  built with its own layer cache), and production releases are built from main only
  (`deploy.yml`: after Web checks on main, or a manual run on main). Test releases never build it,
  and the receiver refuses a test release that carries it, so pushing a branch to test cannot
  change it.
- `scripts/segmenter-deploy.sh up <image> <VERSION>` does nothing when the running container
  already has that version (label `online.muvloom.segmenter.version`) and is healthy. Otherwise it
  starts the new version next to the old one as `image-playground-segmenter-next`; the old one keeps
  serving until the new one answers `/health`. Then every app network is moved over (alias
  `segmenter`), the old container is stopped and kept as `image-playground-segmenter-prev` for
  rollback (the one before that is removed), and the new one takes the name. If the new version
  never gets healthy, only that candidate is removed and the old one is untouched; if moving the
  networks fails halfway, all of them are given back to the old one. The receiver self-tests a new
  version before that and warns instead of failing the release when it does not start.
- To roll out a new segmenter: change `deploy/segmenter`, bump `VERSION`, merge to main. To roll
  back: `docker start image-playground-segmenter-prev` and move the networks back, or bump to a new
  version with the old code.
- `scripts/segmenter-deploy.sh attach <project>` connects it to `<project>_application` with the
  alias `segmenter` (idempotent). Each edition reaches `http://segmenter:8080` on its own app
  network, and the editions still cannot reach each other (no executor joins a shared network).
  It also removes a leftover `image-playground-segmenter-test`/`-prod` container from the
  short-lived per-environment layout once it no longer serves any app network, and then its own
  internal network of the same name once nothing is attached to it. Running it again is a no-op.
- `scripts/vps-deploy.sh`: every edition listed in `SEGMENTER_EDITIONS` (deploy.env, default
  `test`) is attached after its rollout while the shared container is healthy, and its BFF and
  worker get `AGENT_SEGMENTER_URL=http://segmenter:8080` plus `AGENT_SEGMENTER_NAMESPACE=<project>`.
  Test releases only ever attach; they never start, restart or replace it. An edition that does
  not get it (not listed, or the shared container is not serving) is detached instead, so
  "attached to `<project>_application`" always means "this edition uses the segmenter".
- Rollback (`scripts/app-compose.sh rollback`) and any other run of `scripts/rollout-runtime.sh`
  that vps-deploy did not start read that back: attached gives the executors the same two
  variables, not attached leaves them out. The first Compose deploy of a project gets them through
  `deploy/compose.app.yaml`.
- "Serving" means Docker reports the container healthy, or it is running and answers `/health`
  right now: for up to 30 s after `up` replaced it Docker still says `starting`.
- Old `ai-image-playground:segmenter-<VERSION>-<sha>` tags are pruned like the editions' (the
  newest two and the running one are kept), and a release archive does not wait for a deploy-log
  line for the segmenter (there is none).
- Cache keys are `<project>:media:<mediaId>`, so one environment never reuses another's
  embeddings. The service holds no other state and no secrets.
- Turning it on for production editions (needs Nain's go-ahead): set
  `SEGMENTER_EDITIONS="internal paid test"` in deploy.env.

Without `AGENT_SEGMENTER_URL`, or when the call fails or takes longer than 3 s, the edit-region
card falls back to the agent's box.
