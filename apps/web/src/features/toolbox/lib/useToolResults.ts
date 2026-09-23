import { useEffect, useRef, useState } from 'react'
import { type ToolboxItem, toolSource } from '../store'
import { CanvasLimitError } from './canvasLimits'
import type { ToolFailure, ToolOutput, ToolSource } from './tool'

export type ToolResult =
  | { status: 'pending' }
  | { status: 'done'; output: ToolOutput; url: string }
  | { status: 'failed'; failure: ToolFailure }

/** 调参手一停就重算，250ms 内的连续拖动只跑最后一次。 */
const DEBOUNCE_MS = 250

function toFailure(error: unknown): ToolFailure {
  if (error instanceof CanvasLimitError)
    return { code: 'canvasLimit', width: error.width, height: error.height }
  return { code: 'failed' }
}

/**
 * 按当前参数把每张图跑一遍。**串行**：一次 `Promise.all` 几十张 4000px 的图会同时开几十张画布。
 * 新结果一张一张替换旧结果，屏幕上不闪空白。
 *
 * `run` 的身份就是参数的身份——工具把参数绑进闭包，参数一变函数就换人，这个 effect 跟着重跑。
 */
export function useToolResults(
  items: readonly ToolboxItem[],
  run: (source: ToolSource) => Promise<ToolOutput>,
): { results: Map<string, ToolResult>; busy: boolean } {
  const [results, setResults] = useState<Map<string, ToolResult>>(new Map())
  const [busy, setBusy] = useState(false)
  const urls = useRef(new Map<string, string>())

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setBusy(true)
      for (const item of items) {
        if (cancelled) return
        const source = toolSource(item)
        let next: ToolResult
        if (!source) {
          next = { status: 'failed', failure: { code: 'undecodable' } }
        } else {
          try {
            const output = await run(source)
            if (cancelled) return
            const url = URL.createObjectURL(output.blob)
            const previous = urls.current.get(item.id)
            if (previous) URL.revokeObjectURL(previous)
            urls.current.set(item.id, url)
            next = { status: 'done', output, url }
          } catch (error) {
            next = { status: 'failed', failure: toFailure(error) }
          }
        }
        setResults((prev) => new Map(prev).set(item.id, next))
      }
      if (!cancelled) setBusy(false)
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [items, run])

  // 卸载时把预览 URL 全收回来：工具页是在同一个文档里切走的，不收就一直占着那些 blob。
  useEffect(() => {
    const owned = urls.current
    return () => {
      for (const url of owned.values()) URL.revokeObjectURL(url)
      owned.clear()
    }
  }, [])

  return { results, busy }
}
