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
- The model loads on the first request and is released after 10 minutes idle.
- Up to 3 image embeddings are cached. The status probe always uses one fixed key per namespace.
- Measured locally on 2 cores: about 360 MB RSS with the model loaded, about 0.4–0.6 s encode, and 0.05–0.09 s per click for decode.
- Compose limits: `mem_limit` and `memswap_limit` 900m, `cpus` 2.

Deployment: two instances, one per line, so test and production stay isolated.
- `test`: compose project and container `image-playground-segmenter-test`. Only test releases
  carry its image (built in CI with its own layer cache) and start or update it. Only the test
  app network may be attached to it.
- `prod`: `image-playground-segmenter-prod`, shared by internal and paid. Only production releases
  (built from main) may start or update it, and test networks are never attached to it.
  Production releases do not build the image yet (production is off); see "Turning it on".
- `deploy/compose.segmenter.yaml` is one compose project per instance (`SEGMENTER_INSTANCE`),
  limits `mem_limit`/`memswap_limit` 900m, `cpus` 2, read-only root, no env file, no published
  port. Its own network is `internal: true`.
- `scripts/segmenter-deploy.sh up <test|prod> <image>` starts or updates one instance. A recreated
  container loses its extra networks, so the script notes them first and attaches them again on
  exit, also when the start fails.
- `scripts/segmenter-deploy.sh attach <test|prod> <project>` connects it to
  `<project>_application` with the alias `segmenter`, refusing to cross the test/production line.
  Each edition reaches `http://segmenter:8080` on its own app network, and the editions still
  cannot reach each other (no executor joins a shared network).
- `scripts/vps-deploy.sh` picks the instance from the release target. Every edition listed in
  `SEGMENTER_EDITIONS` (deploy.env, default `test`) is attached after its rollout, and its BFF and
  worker get `AGENT_SEGMENTER_URL=http://segmenter:8080` plus `AGENT_SEGMENTER_NAMESPACE=<project>`.
  A release without the image reuses its own instance when it is healthy.
- Cache keys are `<project>:media:<mediaId>`, so one environment never reuses another's
  embeddings. The service holds no other state and no secrets.
- The formerly shared container `image-playground-segmenter` is only taken off the test network by
  the next test release; it is not removed automatically. Remove it by hand once the test
  instance is up (`docker rm -f image-playground-segmenter`).
- Turning it on for production (needs Nain's go-ahead): let production releases build the image
  (drop the `target = test` condition in `scripts/build-vps-release.sh`) and set
  `SEGMENTER_EDITIONS="internal paid test"` in deploy.env. The next production deploy starts the
  production instance and attaches internal and paid to it.

Without `AGENT_SEGMENTER_URL`, or when the call fails or takes longer than 3 s, the edit-region
card falls back to the agent's box.
