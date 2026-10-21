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
- 2 ORT threads, with the CPU memory arena off.
- The model loads on the first request and is released after 10 minutes idle.
- Up to 3 image embeddings are cached.
- Measured locally on 2 cores: about 360 MB RSS with the model loaded, about 0.4–0.6 s encode, and 0.05–0.09 s per click for decode.
- Compose limits: `mem_limit` and `memswap_limit` 900m, `cpus` 2.

Deployment: one shared instance for the whole VPS (internal, paid and test), approved by Nain.
- `deploy/compose.segmenter.yaml` is its own compose project, `image-playground-segmenter`, like
  infra. Container `image-playground-segmenter`, limits `mem_limit`/`memswap_limit` 900m, `cpus` 2,
  read-only root, no env file, no published port. Its own network is `internal: true`.
- `scripts/segmenter-deploy.sh up <image>` starts or updates it. A recreated container loses its
  extra networks, so the script notes them first and attaches them again: updating it from one
  edition's deploy keeps the others served.
- `scripts/segmenter-deploy.sh attach <project>` connects it to `<project>_application` with the
  alias `segmenter`. Each edition reaches `http://segmenter:8080` on its own app network, and the
  editions still cannot reach each other (no executor joins a shared network).
- `scripts/vps-deploy.sh`: test releases carry the image (built in CI with its own layer cache)
  and start or update it before rolling the executors. Every edition listed in
  `SEGMENTER_EDITIONS` (deploy.env, default `test`) is attached after its rollout, and its BFF and
  worker get `AGENT_SEGMENTER_URL=http://segmenter:8080` plus `AGENT_SEGMENTER_NAMESPACE=<project>`.
  A release without the image (production) reuses the running instance when it is healthy.
- Cache keys are `<project>:media:<mediaId>`, so one environment never reuses another's
  embeddings. The service holds no other state and no secrets.
- Turning it on for production (not done yet; production deploys are separate): set
  `SEGMENTER_EDITIONS="internal paid test"` in deploy.env; the next production deploy attaches
  the running instance. Nothing else changes.

Without `AGENT_SEGMENTER_URL`, or when the call fails or takes longer than 3 s, the edit-region
card falls back to the agent's box.
