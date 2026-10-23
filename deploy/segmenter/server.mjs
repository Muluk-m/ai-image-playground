// Stateless EdgeTAM segmentation for the agent's edit-region proposals (PR #1420).
//
// One process, one request at a time: the BFF sends an image (or a cache key it sent before),
// a box and include/exclude points, and gets back the model's three candidate masks with their
// scores. Picking, dilation and storage stay in the BFF. No secrets, no database, no outbound
// network: the weights are baked into the image at build time (fetch-model.mjs).
//
// Memory: the model is loaded on the first request and released after SEGMENTER_IDLE_MS without
// one. The freed memory is not returned to the OS, so an idle container still sits at about
// 450 MB RSS (measured on the VPS). Up to SEGMENTER_CACHE image embeddings
// stay in memory so include/exclude clicks only run the small decoder.
import http from 'node:http'
import { AutoProcessor, EdgeTamModel, env, RawImage } from '@huggingface/transformers'

const PORT = Number(process.env.PORT ?? 8080)
const MODEL_DIR = process.env.SEGMENTER_MODEL_DIR ?? '/models'
const MODEL_ID = 'EdgeTAM-ONNX'
const DTYPE = process.env.SEGMENTER_DTYPE ?? 'fp16'
const THREADS = Math.max(1, Number(process.env.SEGMENTER_THREADS ?? 2))
const IDLE_MS = Math.max(10_000, Number(process.env.SEGMENTER_IDLE_MS ?? 600_000))
const CACHE_SIZE = Math.max(1, Number(process.env.SEGMENTER_CACHE ?? 3))
/** Requests waiting behind the one that runs. More than this is refused, not queued forever. */
const QUEUE_MAX = Math.max(0, Number(process.env.SEGMENTER_QUEUE_MAX ?? 4))
/**
 * In flight (running or waiting) per deployment namespace. Editions share this one process, so a
 * single edition (or one user clicking fast in it) must not fill the whole queue for the others.
 */
const NAMESPACE_MAX = Math.max(1, Number(process.env.SEGMENTER_NAMESPACE_MAX ?? 2))
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_EDGE = 4096
const MAX_POINTS = 16

env.allowRemoteModels = false
env.allowLocalModels = true
// The container's root filesystem is read-only: nothing is downloaded, so nothing is cached.
env.useFSCache = false
env.useBrowserCache = false
env.localModelPath = `${MODEL_DIR}/`

let loaded = null
let loading = null
let idleTimer = null
let running = 0
let waiting = 0
let chain = Promise.resolve()
const inFlight = new Map()
const cache = new Map()
const stats = { requests: 0, encodes: 0, loads: 0, unloads: 0 }

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}

async function ensureLoaded() {
  if (loaded) return loaded
  loading ??= (async () => {
    const startedAt = performance.now()
    const options = {
      dtype: DTYPE,
      device: 'cpu',
      session_options: {
        intraOpNumThreads: THREADS,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
      },
    }
    const [model, processor] = await Promise.all([
      EdgeTamModel.from_pretrained(MODEL_ID, options),
      AutoProcessor.from_pretrained(MODEL_ID),
    ])
    loaded = { model, processor }
    stats.loads++
    log('segmenter.loaded', { ms: Math.round(performance.now() - startedAt), dtype: DTYPE })
    return loaded
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

async function unload() {
  if (!loaded || running || waiting) return
  const current = loaded
  loaded = null
  cache.clear()
  stats.unloads++
  await current.model.dispose?.()
  log('segmenter.unloaded', { rssMB: Math.round(process.memoryUsage().rss / 1e6) })
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void unload().catch((error) => log('segmenter.unload_failed', { error: String(error) })), IDLE_MS)
  idleTimer.unref()
}

class RequestError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

function parseRequest(body) {
  if (!body || typeof body !== 'object') throw new RequestError(400, 'invalid_body')
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key || key.length > 200) throw new RequestError(400, 'invalid_key')
  const namespace = typeof body.namespace === 'string' ? body.namespace.trim().slice(0, 100) : ''
  const image = typeof body.image === 'string' && body.image ? Buffer.from(body.image, 'base64') : null
  const box = body.box
  if (box !== undefined && !(Array.isArray(box) && box.length === 4 && box.every(unit) && box[2] > box[0] && box[3] > box[1]))
    throw new RequestError(400, 'invalid_box')
  const points = body.points ?? []
  if (!Array.isArray(points) || points.length > MAX_POINTS) throw new RequestError(400, 'invalid_points')
  for (const point of points)
    if (!Array.isArray(point) || point.length !== 3 || !unit(point[0]) || !unit(point[1]) || (point[2] !== 0 && point[2] !== 1))
      throw new RequestError(400, 'invalid_points')
  if (!box && !points.length) throw new RequestError(400, 'prompt_required')
  const output = body.output ?? {}
  const outWidth = Number(output.width ?? 0)
  const outHeight = Number(output.height ?? 0)
  if (
    (outWidth || outHeight) &&
    !(Number.isInteger(outWidth) && Number.isInteger(outHeight) && outWidth > 0 && outHeight > 0 && Math.max(outWidth, outHeight) <= MAX_OUTPUT_EDGE)
  )
    throw new RequestError(400, 'invalid_output')
  return { key, namespace, image, box, points, outWidth, outHeight }
}

function remember(key, entry) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value)
}

function packBits(data, offset, length) {
  const packed = new Uint8Array((length + 7) >> 3)
  for (let i = 0; i < length; i++) if (data[offset + i]) packed[i >> 3] |= 128 >> (i & 7)
  return Buffer.from(packed).toString('base64')
}

async function segment(request) {
  const { model, processor } = await ensureLoaded()
  const imageProcessor = processor.image_processor ?? processor
  // Editions share this process and may use the same media ID (restored or copied fixtures), so
  // an embedding is only ever reused within the namespace that computed it.
  const cacheKey = `${request.namespace}\n${request.key}`
  let entry = cache.get(cacheKey)
  let encodeMs = 0
  if (!entry) {
    if (!request.image && !request.raw) throw new RequestError(404, 'image_required')
    const startedAt = performance.now()
    const raw = request.raw ?? (await RawImage.fromBlob(new Blob([request.image])))
    const inputs = await processor(raw.rgb())
    const embeddings = await model.get_image_embeddings(inputs)
    entry = {
      embeddings,
      width: raw.width,
      height: raw.height,
      reshaped: inputs.reshaped_input_sizes,
      original: inputs.original_sizes,
    }
    encodeMs = Math.round(performance.now() - startedAt)
    stats.encodes++
  }
  remember(cacheKey, entry)
  const startedAt = performance.now()
  const prompt = {}
  if (request.points.length) {
    prompt.input_points = imageProcessor.reshape_input_points(
      [[request.points.map(([x, y]) => [x * entry.width, y * entry.height])]],
      entry.original,
      entry.reshaped,
    )
    prompt.input_labels = imageProcessor.add_input_labels([[request.points.map((point) => point[2])]], prompt.input_points)
  }
  if (request.box) {
    const [x0, y0, x1, y1] = request.box
    prompt.input_boxes = imageProcessor.reshape_input_points(
      [[[x0 * entry.width, y0 * entry.height, x1 * entry.width, y1 * entry.height]]],
      entry.original,
      entry.reshaped,
      true,
    )
  }
  const outputs = await model({ ...entry.embeddings, ...prompt })
  const decodeMs = Math.round(performance.now() - startedAt)
  const width = request.outWidth || entry.width
  const height = request.outHeight || entry.height
  const masks = await processor.post_process_masks(outputs.pred_masks, [[height, width]], entry.reshaped)
  const tensor = masks[0]
  const count = tensor.dims.at(-3)
  const scores = Array.from(outputs.iou_scores.data)
  const length = width * height
  return {
    width,
    height,
    masks: Array.from({ length: count }, (_, index) => ({
      score: Number((scores[index] ?? 0).toFixed(4)),
      bits: packBits(tensor.data, index * length, length),
    })),
    timings: { encodeMs, decodeMs, postMs: Math.round(performance.now() - startedAt) - decodeMs, cached: encodeMs === 0 },
  }
}

/**
 * One at a time: the model gets both threads, and a second request never doubles the memory.
 * A namespace already holding NAMESPACE_MAX slots is refused before the shared limit is reached.
 */
function enqueue(namespace, task) {
  if (running + waiting > QUEUE_MAX) return Promise.reject(new RequestError(503, 'busy'))
  const held = inFlight.get(namespace) ?? 0
  if (held >= NAMESPACE_MAX) return Promise.reject(new RequestError(503, 'busy'))
  inFlight.set(namespace, held + 1)
  waiting++
  const result = chain.then(async () => {
    waiting--
    running++
    try {
      return await task()
    } finally {
      running--
      const left = (inFlight.get(namespace) ?? 1) - 1
      if (left > 0) inFlight.set(namespace, left)
      else inFlight.delete(namespace)
      touch()
    }
  })
  chain = result.catch(() => {})
  return result
}

function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError(413, 'too_large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      send(response, 200, {
        ok: true,
        model: MODEL_ID,
        dtype: DTYPE,
        threads: THREADS,
        loaded: Boolean(loaded),
        cached: cache.size,
        running,
        waiting,
        rssMB: Math.round(process.memoryUsage().rss / 1e6),
        version: process.env.APP_VERSION ?? 'unknown',
        ...stats,
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/segment') {
      send(response, 404, { error: 'not_found' })
      return
    }
    let body
    try {
      body = JSON.parse((await readBody(request)).toString('utf8'))
    } catch (error) {
      throw error instanceof RequestError ? error : new RequestError(400, 'invalid_json')
    }
    const parsed = parseRequest(body)
    stats.requests++
    const result = await enqueue(parsed.namespace, () => segment(parsed))
    log('segmenter.segment', { ...result.timings, points: parsed.points.length, box: Boolean(parsed.box) })
    send(response, 200, result)
  } catch (error) {
    if (error instanceof RequestError) {
      send(response, error.status, { error: error.code })
      return
    }
    log('segmenter.failed', { error: error instanceof Error ? error.message : String(error) })
    send(response, 500, { error: 'segment_failed' })
  }
})

async function selfTest() {
  // A 64×64 gradient with a bright square: enough to load both sessions and run one prompt.
  const width = 64
  const height = 64
  const pixels = new Uint8ClampedArray(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = x > 20 && x < 44 && y > 20 && y < 44
      pixels.set(inside ? [240, 240, 240] : [x * 2, y * 2, 40], (y * width + x) * 3)
    }
  const result = await segment({
    key: 'self-test',
    image: null,
    raw: new RawImage(pixels, width, height, 3),
    box: [0.3, 0.3, 0.7, 0.7],
    points: [[0.5, 0.5, 1]],
    outWidth: 0,
    outHeight: 0,
  })
  if (result.masks.length !== 3) throw new Error(`expected 3 masks, got ${result.masks.length}`)
  log('segmenter.self_test_ok', { ...result.timings, rssMB: Math.round(process.memoryUsage().rss / 1e6) })
}

if (process.argv.includes('--self-test')) {
  selfTest().then(
    () => process.exit(0),
    (error) => {
      log('segmenter.self_test_failed', { error: String(error) })
      process.exit(1)
    },
  )
} else {
  server.listen(PORT, () => log('segmenter.listening', { port: PORT, dtype: DTYPE, threads: THREADS, idleMs: IDLE_MS }))
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
