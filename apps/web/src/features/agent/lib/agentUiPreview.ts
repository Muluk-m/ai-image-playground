import type { AgentToolArtifact } from '@image-playground/shared'
import type { CanvasWorkspace } from '../../canvas/lib/workspaces'
import { useAgentStore } from '../store'
import type { AgentPanelMessage } from '../types'

const IDS = [
  'preview-older-1',
  'preview-older-2',
  'preview-older-3',
  'preview-latest-1',
  'preview-latest-2',
]
const COLORS = [
  ['#ad825a', '#e7d3a8'],
  ['#7f9d97', '#d5e2d7'],
  ['#a87d79', '#e7c4b3'],
  ['#917e55', '#e6d19d'],
  ['#6f8889', '#d5ded2'],
] as const

function image(index: number): string {
  const [start, end] = COLORS[index]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="g"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><ellipse cx="205" cy="315" rx="125" ry="25" fill="#222" opacity=".18"/><rect x="116" y="123" width="168" height="168" rx="25" fill="#f3e6cc"/><path d="M284 163h29c36 0 36 77 0 77h-29" fill="none" stroke="#f3e6cc" stroke-width="20"/><ellipse cx="200" cy="125" rx="84" ry="18" fill="#ead8bb"/><ellipse cx="200" cy="125" rx="66" ry="12" fill="#674737"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function artifact(id: string, index: number): AgentToolArtifact {
  return {
    artifactId: id,
    media: 'image',
    taskId: 'preview',
    outputIndex: index,
    mime: 'image/svg+xml',
  }
}

const messages: AgentPanelMessage[] = [
  {
    kind: 'text',
    id: 'preview-user-1',
    turnId: 'preview-turn-1',
    role: 'user',
    text: '做一组秋季咖啡海报，先试试生活方式方向。',
    streaming: false,
  },
  {
    kind: 'text',
    id: 'preview-agent-1',
    turnId: 'preview-turn-1',
    role: 'assistant',
    text: '先看三种暖色调的画面。',
    streaming: false,
  },
  {
    kind: 'tool',
    id: 'preview-result-older',
    turnId: 'preview-turn-1',
    toolCallId: 'preview-call-older',
    toolName: 'generateImage',
    title: '生活方式',
    status: 'succeeded',
    delivery: 'placed',
    artifacts: IDS.slice(0, 3).map(artifact),
  },
  {
    kind: 'text',
    id: 'preview-user-2',
    turnId: 'preview-turn-2',
    role: 'user',
    text: '再试试更克制的静物摄影，突出咖啡杯。',
    streaming: false,
  },
  {
    kind: 'text',
    id: 'preview-agent-2',
    turnId: 'preview-turn-2',
    role: 'assistant',
    text: '做了两版静物方向，留出更多文案空间。',
    streaming: false,
  },
  {
    kind: 'tool',
    id: 'preview-result-latest',
    turnId: 'preview-turn-2',
    toolCallId: 'preview-call-latest',
    toolName: 'generateImage',
    title: '静物摄影',
    status: 'succeeded',
    delivery: 'placed',
    artifacts: IDS.slice(3).map(artifact),
  },
]

export async function seedAgentUiPreview(workspace: CanvasWorkspace): Promise<void> {
  if (!import.meta.env.DEV) return
  await workspace.ready
  if (workspace.cloud || useAgentStore.getState().conversationId) return
  workspace.editor.placeImages(
    IDS.flatMap((id, index) =>
      workspace.editor.getElement(id)
        ? []
        : [
            {
              id,
              dataUrl: image(index),
              x: index < 3 ? 1500 + index * 410 : 80 + (index - 3) * 410,
              y: 120,
              width: 350,
              height: 350,
              naturalWidth: 400,
              naturalHeight: 400,
              name: index < 3 ? `生活方式 ${index + 1}` : `静物摄影 ${index - 2}`,
              groupId: index < 3 ? 'preview-older' : 'preview-latest',
            },
          ],
    ),
  )
  useAgentStore.setState({ loaded: true, historyLoading: false, historyFailed: false, messages })
}
