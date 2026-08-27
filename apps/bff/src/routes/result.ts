import type { ResultResponse, TaskErrorType } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { pixelStore, taskStore } from '../db/client'
import { getTaskBlob } from '../lib/blobStore'
import { extractMeta, resolveImageBytesRef } from '../lib/extractImages'
import { jsonResponse } from '../lib/gzipResponse'
import { asQueueProvider } from '../lib/queueProvider'

// request_id + index 是稳定 key，结果不可变 → 永久缓存
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export const resultRoutes = new Elysia()
  // 1) 元信息端点：返回图片列表 + actual_params + raw_image_urls；不含像素字节
  .get(
    '/v1/queue/requests/:id',
    async ({ params, status, request }) => {
      const task = await taskStore.getById(params.id)

      if (!task) return status(404, { error: 'task_not_found' })

      if (task.status === 'completed') {
        const provider = asQueueProvider(task.provider)
        if (!provider) return status(500, { error: `unknown_provider:${task.provider}` })
        const meta = extractMeta(provider, task.result_payload)
        const body: ResultResponse = {
          request_id: task.id,
          status: 'completed',
          images: meta.images,
          ...(meta.actual_params ? { actual_params: meta.actual_params } : {}),
          ...(meta.raw_image_urls ? { raw_image_urls: meta.raw_image_urls } : {}),
        }
        return jsonResponse(body, request)
      }
      if (task.status === 'failed') {
        const body: ResultResponse = {
          request_id: task.id,
          status: 'failed',
          error: {
            message: task.error_message ?? 'unknown',
            type: (task.error_type ?? 'unknown') as TaskErrorType,
          },
        }
        return jsonResponse(body, request)
      }
      if (task.status === 'cancelled') {
        return jsonResponse({ request_id: task.id, status: 'cancelled' } as ResultResponse, request)
      }
      return status(425, { error: 'task_not_ready' })
    },
    { params: t.Object({ id: t.String() }) },
  )
  // 2) 二进制端点：按 index 返回原始像素字节，跳过 base64 + JSON 双重开销
  .get(
    '/v1/queue/requests/:id/image/:index',
    async ({ params, status }) => {
      const task = await taskStore.getById(params.id)
      if (!task || task.status !== 'completed') return status(404, { error: 'not_ready' })
      const provider = asQueueProvider(task.provider)
      if (!provider) return status(500, { error: `unknown_provider:${task.provider}` })
      const idx = Number(params.index)
      if (!Number.isInteger(idx) || idx < 0) return status(400, { error: 'bad_index' })

      const ref = resolveImageBytesRef(provider, task.result_payload, idx)
      if (!ref) {
        // 像素已外置到 task_blobs，payload 里只剩 _image_meta
        const blob = await getTaskBlob(params.id, 'output', idx, pixelStore)
        if (!blob) return status(404, { error: 'image_not_found' })
        return new Response(new Uint8Array(blob.data), {
          headers: { 'content-type': blob.mime, 'cache-control': IMAGE_CACHE_CONTROL },
        })
      }

      const headers = {
        'content-type': ref.mime,
        'cache-control': IMAGE_CACHE_CONTROL,
      } as const

      if (ref.kind === 'b64') {
        const bytes = Buffer.from(ref.data, 'base64')
        return new Response(bytes, { headers })
      }
      // kind === 'url'：上游返回了 http 地址，BFF 现拉回来透传给客户端
      const upstream = await fetch(ref.data)
      if (!upstream.ok || !upstream.body) {
        return status(502, { error: `upstream_image_${upstream.status}` })
      }
      const mime = upstream.headers.get('content-type') ?? ref.mime
      return new Response(upstream.body, { headers: { ...headers, 'content-type': mime } })
    },
    {
      params: t.Object({
        id: t.String(),
        index: t.String(),
      }),
    },
  )
