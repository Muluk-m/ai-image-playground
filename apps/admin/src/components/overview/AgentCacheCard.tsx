import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RANGE_LABEL, type Range } from '@/lib/search-params'
import type { OverviewResult } from '@/lib/types'

function cacheRate(readTokens: number, inputTokens: number): string {
  return inputTokens > 0 ? `${((readTokens / inputTokens) * 100).toFixed(1)}%` : '—'
}

/** Agent 输入缓存命中率：成本细项，放在概览最下面。 */
export function AgentCacheCard({
  agent_cache,
  range,
}: {
  agent_cache: OverviewResult['agent_cache']
  range: Range
}) {
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">Agent 输入缓存 · {RANGE_LABEL[range]}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {cacheRate(agent_cache.cache_read_tokens, agent_cache.input_tokens)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            缓存命中率 = 缓存读取 token / 输入 token · {agent_cache.calls.toLocaleString('zh-CN')}{' '}
            次已上报用量的对话调用
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">每轮首调</p>
            <p className="font-mono text-lg font-semibold tabular-nums">
              {cacheRate(
                agent_cache.first_call.cache_read_tokens,
                agent_cache.first_call.input_tokens,
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {agent_cache.first_call.calls.toLocaleString('zh-CN')} 次，含新对话及后续轮首次调用
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">轮内续调</p>
            <p className="font-mono text-lg font-semibold tabular-nums">
              {cacheRate(
                agent_cache.continuation.cache_read_tokens,
                agent_cache.continuation.input_tokens,
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {agent_cache.continuation.calls.toLocaleString('zh-CN')} 次，同一轮工具调用后继续
            </p>
          </div>
        </div>
        {agent_cache.models.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">调用</TableHead>
                <TableHead className="text-right">缓存读取</TableHead>
                <TableHead className="text-right">输入 token</TableHead>
                <TableHead className="text-right">命中率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agent_cache.models.map((model) => (
                <TableRow key={model.model}>
                  <TableCell className="max-w-[240px] truncate font-mono text-xs">
                    {model.model}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {model.calls.toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {model.cache_read_tokens.toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {model.input_tokens.toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {cacheRate(model.cache_read_tokens, model.input_tokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">当前范围内暂无可统计的 Agent 用量</p>
        )}
        <p className="text-xs text-muted-foreground">
          网关未上报缓存明细时可能显示 0%，请结合上游用量数据判断。
        </p>
      </CardContent>
    </Card>
  )
}
