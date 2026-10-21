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

Deployment: `deploy/compose.app.yaml` service `segmenter`, profile `segmenter`. `scripts/vps-deploy.sh` starts it for the
test project only and passes `AGENT_SEGMENTER_URL=http://segmenter:8080` to that project's BFF and worker.

Sharing one instance with production later (needs Nain's approval):
- Run the container once, outside any one project, on the shared `image-playground-infra` network,
  for example as compose project `image-playground-segmenter` with only this service.
- Give it a network alias such as `aip-segmenter`.
- Point each deployment's `AGENT_SEGMENTER_URL` at `http://aip-segmenter:8080`.
- BFF and worker are already on that network.
- The service holds no state or secrets, so sharing it does not mix data between deployments. Only the cache keys (`media:<id>`) pass through it.

Without `AGENT_SEGMENTER_URL`, or when the call fails or takes longer than 3 s, the edit-region
card falls back to the agent's box.
