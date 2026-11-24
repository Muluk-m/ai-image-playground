// @vitest-environment jsdom

import type { GeminiDirectAdminView } from '@image-playground/shared'
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

const view: GeminiDirectAdminView = {
  generated_at: 1,
  currency_note: 'estimated',
  days: 7,
  source: 'admin',
  revision: 2,
  fingerprint_mac_source: 'INTERNAL_API_TOKEN',
  writable: true,
  disabled_reason: null,
  keys: [
    {
      id: 'gkey-1',
      ordinal: 1,
      fingerprint: 'abcd1234',
      label: 'abcd1234…6789',
      enabled: true,
      source: 'admin',
      status: 'cooldown',
      disabled_reason: null,
      budget_usd: 200,
      budget_micro_usd: 200_000_000,
      spent_micro_usd: 15_000_000,
      requests: 42,
      succeeded: 40,
      images: 40,
      rate_limited: 2,
      cooldown_until: Date.now() + 30_000,
      last_error: 'HTTP 429',
      last_error_at: Date.now() - 5_000,
    },
  ],
  total_spent_micro_usd: 15_000_000,
  total_budget_micro_usd: 200_000_000,
  remaining_micro_usd: 185_000_000,
  window_requests: 42,
  window_succeeded: 40,
  window_images: 40,
  window_rate_limited: 2,
  window_cost_micro_usd: 15_000_000,
  daily: [
    {
      day: '2026-11-24',
      requests: 42,
      succeeded: 40,
      images: 40,
      rate_limited: 2,
      cost_micro_usd: 15_000_000,
    },
  ],
  by_model: [
    {
      model: 'gemini-nano-banana-2.1',
      requests: 42,
      succeeded: 40,
      images: 40,
      rate_limited: 2,
      cost_micro_usd: 15_000_000,
    },
  ],
}

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
}))
vi.mock('../../../lib/api-client', () => ({ ApiError: class ApiError extends Error {} }))
vi.mock('../../../lib/queries', () => ({
  createGeminiDirectKey: state.create,
  deleteGeminiDirectKey: state.remove,
  geminiDirectQueryKey: ['gemini-direct'],
  reorderGeminiDirectKeys: state.reorder,
  restoreGeminiDirectKey: state.restore,
  updateGeminiDirectKey: state.update,
}))

import { GeminiDirectPanel } from '../../../features/providers/GeminiDirectPanel'

describe('GeminiDirectPanel', () => {
  beforeEach(() => {
    state.invalidateQueries.mockClear()
    state.create.mockReset()
    state.create.mockResolvedValue(view)
    state.update.mockReset()
    state.update.mockResolvedValue(view)
    state.remove.mockReset()
    state.remove.mockResolvedValue(view)
    state.reorder.mockReset()
    state.restore.mockReset()
    state.restore.mockResolvedValue(view)
  })

  it('renders KPIs, daily/model stats, adds a key without leaking secret, and restores cooldown key', async () => {
    const secret = 'AIzaSy-secret-gemini-9999'
    render(<GeminiDirectPanel view={view} />)

    expect(screen.getByText('Nano Banana 2.1')).toBeInTheDocument()
    expect(screen.getAllByText('42 次').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('2 次').length).toBeGreaterThanOrEqual(1)

    // Add key
    fireEvent.change(screen.getByLabelText('新 Gemini 密钥'), { target: { value: secret } })
    fireEvent.change(screen.getByLabelText('Gemini 月预算'), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith({ apiKey: secret, budgetUsd: 300 }),
    )
    expect(screen.queryByText(secret)).not.toBeInTheDocument()
    expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['gemini-direct'] })

    // Restore cooldown key
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(state.restore).toHaveBeenCalledWith('abcd1234'))
  })

  it('requires confirmation dialog before deleting an admin key', async () => {
    render(<GeminiDirectPanel view={view} />)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByRole('dialog', { name: '删除 Gemini 直连密钥' })).toBeInTheDocument()
    expect(state.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('gkey-1'))
  })
})
