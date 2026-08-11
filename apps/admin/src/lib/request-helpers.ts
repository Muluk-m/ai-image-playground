// 从 task.request_payload 抽通用字段的纯函数。被 TaskTable / TaskDetailView /
// LightboxDialog 复用，避免三处分别实现走偏。

export function extractPrompt(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const req = payload as Record<string, unknown>
  if (typeof req.prompt === 'string') return req.prompt
  // gemini-style: contents[].parts[].text 顺序拼接
  const contents = req.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined
  if (!Array.isArray(contents)) return ''
  return contents
    .flatMap((c) => c.parts ?? [])
    .map((p) => p?.text ?? '')
    .filter(Boolean)
    .join('\n')
}

export function extractN(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const n = (payload as Record<string, unknown>).n
  return typeof n === 'number' ? n : null
}

export type InputImageCount =
  | { kind: 'count'; count: number }
  | { kind: 'not_archived' }
  | { kind: 'none' }

export function countInputImages(provider: string, payload: unknown): InputImageCount {
  const req = (payload ?? {}) as Record<string, unknown>
  const inputImages = req.input_images
  if (Array.isArray(inputImages) && inputImages.length > 0) {
    return { kind: 'count', count: inputImages.length }
  }
  if (provider === 'gemini') {
    const contents = req.contents as Array<{ parts?: Array<{ inlineData?: unknown }> }> | undefined
    if (!Array.isArray(contents)) return { kind: 'none' }
    let n = 0
    for (const c of contents) for (const p of c.parts ?? []) if (p?.inlineData) n++
    return n > 0 ? { kind: 'count', count: n } : { kind: 'none' }
  }
  // openai-compat: /v1/images/edits 有 image 字段（multipart 直传，BFF 未存档）
  if (req.image !== undefined && req.image !== null) {
    return { kind: 'not_archived' }
  }
  return { kind: 'none' }
}

/** 给 lightbox 翻页用：仅 'count' 形态有 max idx；其它 undefined（不允许翻页） */
export function inputImageMaxIdx(count: InputImageCount): number | undefined {
  return count.kind === 'count' ? count.count - 1 : undefined
}
