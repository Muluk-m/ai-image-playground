// @vitest-environment jsdom

import type { ManagedChannelSummary, ManagedModel } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/private-overlay', () => ({
  PrivateAdminModelPricing: ({
    model,
    mode = 'summary',
    onEdit,
  }: {
    model: string
    mode?: 'summary' | 'editor'
    onEdit?: () => void
  }) => (
    <div data-testid={`pricing-${mode}-${model}`}>
      <span>100 积分/张</span>
      {onEdit ? (
        <button type="button" onClick={onEdit}>
          改价 {model}
        </button>
      ) : null}
    </div>
  ),
  usePrivateAdminOverlayEnabled: () => true,
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ModelCatalogWorkspace } from '../../../features/models/ModelTable'
import { ChannelTopologyPanel } from '../../../features/providers/ChannelTopologyPanel'

const MODELS: ManagedModel[] = [
  {
    id: 'gpt-6-sol',
    label: 'GPT 6 Sol',
    kind: 'chat',
    active: true,
    pause_reason: null,
    paused_at: null,
    source_label: '现有网关',
    source_id: 'upstream-gateway',
    secret_ref: 'UPSTREAM_API_KEY',
    secret_configured: true,
    capabilities: ['vision', 'openai-completions'],
    context_window: 128000,
    max_tokens: 16000,
    agent_profiles: ['default', 'deep'],
  },
  {
    id: 'gemini-nano-banana-2.1',
    label: 'Nano Banana 2.1',
    kind: 'image',
    active: true,
    pause_reason: null,
    paused_at: null,
    source_label: 'Gemini',
    source_id: 'vertex-images',
    secret_ref: 'VERTEX_API_KEY',
    secret_configured: true,
    capabilities: ['generate', 'edit', 'size'],
    max_concurrency: 2,
    eta_seconds: 14,
  },
  {
    id: 'veo-3.1-fast',
    label: 'Veo 3.1 Fast',
    kind: 'video',
    active: false,
    pause_reason: 'upstream_unavailable',
    paused_at: Date.now() - 60_000,
    source_label: 'Veo',
    source_id: 'veo-video',
    secret_ref: 'VEO_API_KEY',
    secret_configured: false,
    capabilities: ['generate', 'duration'],
  },
]

const CHANNELS: ManagedChannelSummary[] = [
  {
    id: 'vertex-images',
    label: 'Gemini',
    kind: 'gemini-queue',
    status: 'active',
    authType: 'bearer',
    secretRef: 'VERTEX_API_KEY',
    secretConfigured: true,
    asyncTasks: false,
    timeoutSeconds: 600,
    models: [
      {
        id: 'gemini-nano-banana-2.1',
        label: 'Nano Banana 2.1',
        media: 'image',
        capabilities: ['generate', 'edit'],
        maxConcurrency: 2,
      },
    ],
  },
  {
    id: 'agnes-images',
    label: 'Agnes AI',
    kind: 'openai-queue',
    status: 'disabled',
    authType: 'bearer',
    secretRef: 'AGNES_API_KEY',
    secretConfigured: false,
    asyncTasks: false,
    models: [],
  },
]

describe('ModelCatalogWorkspace & ChannelTopologyPanel', () => {
  it('unifies chat, image and video models with filtering, search and inspector drawer', () => {
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ModelCatalogWorkspace models={MODELS} />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByText('GPT 6 Sol')).toBeInTheDocument()
    expect(screen.getByText('Nano Banana 2.1')).toBeInTheDocument()
    expect(screen.getByText('Veo 3.1 Fast')).toBeInTheDocument()
    expect(screen.getByTestId('pricing-summary-gpt-6-sol')).toBeInTheDocument()

    // Filter to chat only
    fireEvent.click(screen.getByRole('radio', { name: '对话 (1)' }))
    expect(screen.getByText('GPT 6 Sol')).toBeInTheDocument()
    expect(screen.queryByText('Nano Banana 2.1')).not.toBeInTheDocument()

    // Clicking price edit opens right-hand inspector sheet directly in editor mode
    fireEvent.click(screen.getByRole('button', { name: '改价 gpt-6-sol' }))
    expect(screen.getByText('上游归属与密钥状态')).toBeInTheDocument()
    expect(screen.getByText('商业计费')).toBeInTheDocument()
    expect(screen.getByTestId('pricing-editor-gpt-6-sol')).toBeInTheDocument()
  })

  it('renders upstream channel topology with secret readiness and disabled state', () => {
    render(<ChannelTopologyPanel channels={CHANNELS} />)
    expect(screen.getByText('vertex-images')).toBeInTheDocument()
    expect(screen.getByText('VERTEX_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('密钥已就绪')).toBeInTheDocument()
    expect(screen.getByText('已下线')).toBeInTheDocument()
  })
})
