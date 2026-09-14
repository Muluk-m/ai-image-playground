/**
 * 智能体上线冒烟：建一个会话，起一轮，把 SSE 事件收完并汇总。
 *
 * 在部署的 bff 容器里跑（见 docs/deploy/agent-rollout.md 第七节）：
 *   docker cp scripts/agent-smoke.ts <bff>:/tmp/ && docker exec <bff> bun /tmp/agent-smoke.ts "画一只猫"
 *
 * 计费开着时匿名起轮返回 401，这是对的；收费部署的完整一轮要在浏览器里用真实账号走。
 */
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:37377'
const text = process.argv[2] ?? '你好，用一句话介绍你能做什么'
const deviceId = `smoke-${Date.now()}`

const created = await fetch(`${baseUrl}/api/agent/conversations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId }),
})
const conversationId = ((await created.json()) as { conversation?: { id?: string } }).conversation
  ?.id
console.log('建会话', created.status, conversationId ?? '(失败)')
if (!conversationId) process.exit(1)

const startedAt = Date.now()
const turn = await fetch(`${baseUrl}/api/agent/conversations/${conversationId}/turns`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId, text }),
})
console.log('起轮 HTTP', turn.status, turn.headers.get('content-type'))
if (!turn.body) {
  console.log('响应体:', await turn.text())
  process.exit(1)
}

const counts: Record<string, number> = {}
let reply = ''
let lastEvent = ''
const reader = turn.body.getReader()
const decoder = new TextDecoder()
let pending = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  pending += decoder.decode(value, { stream: true })
  const frames = pending.split('\n\n')
  pending = frames.pop() ?? ''
  for (const frame of frames) {
    const name = /^event:\s*(.+)$/m.exec(frame)?.[1] ?? 'message'
    const data = /^data:\s*([\s\S]*)$/m.exec(frame)?.[1] ?? ''
    counts[name] = (counts[name] ?? 0) + 1
    try {
      const parsed = JSON.parse(data) as { delta?: unknown }
      if (typeof parsed.delta === 'string') reply += parsed.delta
      if (name !== 'textDelta' && name !== 'message') lastEvent = `${name}: ${data.slice(0, 300)}`
    } catch {
      // 非 JSON 帧（心跳等）只计数。
    }
  }
}

console.log('耗时', `${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
console.log('事件计数', JSON.stringify(counts))
console.log('回复', reply.slice(0, 200))
console.log('末个非增量事件', lastEvent)
if (!/"usage"/.test(lastEvent)) {
  console.log('\n警告：turnEnd 没带 usage。网关可能没透传 stream_options，不要开计费上线。')
  process.exit(2)
}
