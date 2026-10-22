import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { copyText, shortId } from '@/lib/format'
import { adminApiUrl } from '@/lib/runtime-config'
import type { AgentPromptItem } from '../../../contracts'
import { PromptDiff } from './PromptDiff'

const states = {
  awaiting: ['待确认', 'text-warning'],
  running: ['生成中', 'text-muted-foreground'],
  completed: ['已完成', 'text-success'],
  failed: ['失败 / 取消', 'text-danger'],
} as const
export function PromptCard({
  item,
  onTask,
}: {
  item: AgentPromptItem
  onTask: (id: string) => void
}) {
  const [copyState, setCopyState] = useState('复制提示词')
  const [imageFailed, setImageFailed] = useState(false)
  const [label, color] = states[item.status]
  return (
    <article
      className="grid min-w-0 rounded-xl border bg-card lg:grid-cols-[minmax(0,1fr)_240px]"
      aria-label={`${label}提示词`}
    >
      <div className="min-w-0 space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span className={`font-medium ${color}`}>{label}</span>
          <span className="rounded-md bg-muted px-2 py-1 font-mono">{item.tool}</span>
          <span className="break-all font-mono text-muted-foreground">{item.model}</span>
          {item.edited === true ? (
            <span className="font-medium text-foreground">确认前被改过</span>
          ) : null}
          {item.draftedPrompt === null ? (
            <span className="text-muted-foreground">原稿未记录</span>
          ) : null}
        </div>
        {item.edited && item.draftedPrompt !== null ? (
          <>
            <p className="text-xs text-muted-foreground">
              原稿 → 提交稿 · <span className="text-danger">删除</span> /{' '}
              <span className="text-success">新增</span>
            </p>
            <PromptDiff original={item.draftedPrompt} submitted={item.prompt} />
          </>
        ) : (
          <p className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
            {item.prompt}
          </p>
        )}
        <div className="border-t pt-3 text-xs leading-5">
          <span className="text-muted-foreground">用户原话：</span>
          <span className="whitespace-pre-wrap break-words">
            {item.userText ?? '后台唤醒（无用户原话）'}
          </span>
        </div>
      </div>
      <aside className="min-w-0 space-y-3 border-t bg-muted/20 p-4 text-xs lg:border-l lg:border-t-0">
        {item.userId ? (
          <Link
            className="inline-flex min-h-9 items-center break-all font-medium underline-offset-4 hover:underline"
            to="/users/$userId"
            params={{ userId: item.userId }}
            search={{}}
          >
            {item.username ?? `用户 ${shortId(item.userId)}`}
          </Link>
        ) : (
          <p className="break-all font-medium">
            匿名设备 {item.deviceId ? shortId(item.deviceId) : '—'}
          </p>
        )}
        <p className="tabular-nums text-muted-foreground">
          {new Date(item.createdAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          })}
        </p>
        <div className="space-y-1 text-muted-foreground">
          <p className="break-all">
            Chat · <span className="font-mono">{item.chatModel ?? '未记录'}</span>
          </p>
          <p>
            本轮 token · 输入 {item.inputTokens.toLocaleString()} / 输出{' '}
            {item.outputTokens.toLocaleString()}
          </p>
        </div>
        {item.taskId && item.status === 'completed' && item.media === 'image' && !imageFailed ? (
          <button
            type="button"
            onClick={() => onTask(item.taskId!)}
            className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="查看产物与任务详情"
          >
            <img
              className="h-24 w-24 rounded-md border object-cover"
              crossOrigin="use-credentials"
              loading="lazy"
              src={adminApiUrl(`/api/tasks/${encodeURIComponent(item.taskId)}/image?idx=0`)}
              alt="生成产物"
              onError={() => setImageFailed(true)}
            />
          </button>
        ) : (
          <p className="text-muted-foreground">
            {item.status === 'awaiting'
              ? '草稿尚未提交'
              : item.status === 'running'
                ? '等待生成结果'
                : '在任务详情中查看结果'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={async () =>
              setCopyState((await copyText(item.prompt)) ? '已复制' : '复制失败，请重试')
            }
          >
            {copyState}
          </Button>
          {item.taskIds && item.taskIds.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{item.taskIds.length} 张任务</span>
              {item.taskIds.map((taskId, index) => (
                <Button key={taskId} variant="outline" onClick={() => onTask(taskId)}>
                  查看 {index + 1}
                </Button>
              ))}
            </div>
          ) : item.taskId ? (
            <Button variant="outline" onClick={() => onTask(item.taskId!)}>
              查看任务
            </Button>
          ) : null}
        </div>
        <details className="text-muted-foreground">
          <summary className="min-h-9 cursor-pointer py-2">会话与轮次</summary>
          <p className="break-all font-mono">会话 {item.conversationId}</p>
          <p className="break-all font-mono">轮次 {item.turnId ?? '未记录'}</p>
        </details>
      </aside>
    </article>
  )
}
