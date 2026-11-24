// @vitest-environment jsdom

import type { Catalog } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}))

vi.mock('../../../lib/private-host', () => ({
  apiClient: {
    get: state.get,
    put: state.put,
  },
}))

import { ModelPricing } from '../../../features/billing/ModelPricing'

function makeCatalog(updatedAt: number, outputCredits: number): Catalog {
  return {
    recharge_pricing: { credits_per_yuan: 400, amounts_yuan: [10, 50, 100] },
    plans: [],
    settings: null,
    model_prices: [
      {
        model: 'gpt-6-sol',
        credits_per_image: 6,
        unit: 'kilo_token',
        output_credits_per_unit: outputCredits,
        output_reserve_tokens: 2000,
        cached_input_price_percent: 10,
        active: true,
        updated_at: updatedAt,
      },
    ],
  }
}

describe('ModelPricing', () => {
  it('shows 积分/千tok unit in summary mode and blocks saving on concurrent server price update', async () => {
    const initialCatalog = makeCatalog(1000, 30)
    state.get.mockResolvedValue(initialCatalog)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    client.setQueryData(['private-billing', 'catalog'], initialCatalog)

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <ModelPricing model="gpt-6-sol" kind="chat" mode="summary" onEdit={() => {}} />
      </QueryClientProvider>,
    )
    expect(screen.getByText('积分/千tok')).toBeInTheDocument()

    rerender(
      <QueryClientProvider client={client}>
        <ModelPricing model="gpt-6-sol" kind="chat" mode="editor" />
      </QueryClientProvider>,
    )

    const inputAmount = screen.getByLabelText('输入（积分/千tok）')
    fireEvent.change(inputAmount, { target: { value: '8' } })
    expect(screen.getByRole('button', { name: '保存定价' })).not.toBeDisabled()

    // Another operator updates the model price while this drawer holds a dirty draft
    client.setQueryData(['private-billing', 'catalog'], makeCatalog(2000, 45))
    expect(await screen.findByRole('status')).toHaveTextContent('服务端单价已有新版本')
    expect(screen.getByRole('button', { name: '保存定价' })).toBeDisabled()
    expect(inputAmount).toHaveValue(8)

    fireEvent.click(screen.getByRole('button', { name: '载入最新' }))
    expect(screen.getByLabelText('输出（积分/千tok）')).toHaveValue(45)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
