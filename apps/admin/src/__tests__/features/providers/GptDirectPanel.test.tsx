// @vitest-environment jsdom

import type { GptDirectAdminView } from '@image-playground/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  invalidateQueries: vi.fn(async () => {}),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
  restore: vi.fn(),
}))

const view: GptDirectAdminView = {
  generated_at: 1,
  currency_note: 'usage',
  days: 7,
  source: 'admin',
  revision: 2,
  fingerprint_mac_source: 'INTERNAL_API_TOKEN',
  writable: true,
  disabled_reason: null,
  keys: [
    {
      id: 'key-1',
      ordinal: 1,
      fingerprint: 'abcd1234',
      label: 'abcd1234 · 6789',
      enabled: true,
      source: 'admin',
      status: 'available',
      disabled_reason: null,
      budget_usd: 200,
      budget_micro_usd: 200_000_000,
      spent_micro_usd: 10_000_000,
      cooldown_until: null,
      last_error: null,
      last_error_at: null,
    },
  ],
  total_spent_micro_usd: 10_000_000,
  total_budget_micro_usd: 200_000_000,
  remaining_micro_usd: 190_000_000,
  daily: [],
  official: null,
}

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
}))
vi.mock('../../../lib/api-client', () => ({ ApiError: class ApiError extends Error {} }))
vi.mock('../../../lib/queries', () => ({
  createGptDirectKey: state.create,
  deleteGptDirectKey: state.remove,
  gptDirectQueryKey: ['gpt-direct'],
  reorderGptDirectKeys: state.reorder,
  restoreGptDirectKey: state.restore,
  updateGptDirectKey: state.update,
}))

import { GptDirectPanel } from '../../../features/providers/GptDirectPanel'

describe('GptDirectPanel', () => {
  beforeEach(() => {
    state.invalidateQueries.mockClear()
    state.create.mockReset()
    state.create.mockResolvedValue(view)
    state.update.mockReset()
    state.remove.mockReset()
    state.reorder.mockReset()
    state.restore.mockReset()
  })

  it('adds a key and never renders the entered secret or existing key material', async () => {
    const secret = '{{SECRET_8g3h2j4k}}'
    render(<GptDirectPanel view={view} />)

    expect(screen.queryByText(secret)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('新密钥'), { target: { value: secret } })
    fireEvent.change(screen.getByLabelText('月预算'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith({ apiKey: secret, budgetUsd: 500 }),
    )
    expect(screen.queryByText(secret)).not.toBeInTheDocument()
    expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['gpt-direct'] })
  })
})
