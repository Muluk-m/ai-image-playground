import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { UserFormDialog } from '../../components/UserFormDialog'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <UserFormDialog mode="create" open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { onOpenChange, user: userEvent.setup() }
}

describe('UserFormDialog', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses a username pattern accepted by modern browsers', () => {
    renderDialog()
    const input = screen.getByLabelText<HTMLInputElement>('用户名')
    expect(() => new RegExp(input.pattern, 'v')).not.toThrow()
  })

  it('creates a user and closes after success', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(201, {
        user: { id: 'user-1', username: 'designer-01', status: 'active' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onOpenChange, user } = renderDialog()

    await user.type(screen.getByLabelText('用户名'), 'Designer-01')
    await user.type(screen.getByLabelText('初始密码'), 'strong-password')
    await user.click(screen.getByRole('button', { name: '创建用户' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'Designer-01', password: 'strong-password' }),
        }),
      )
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('shows a useful message when the username already exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(409, { error: 'username_taken' })),
    )
    const { onOpenChange, user } = renderDialog()

    await user.type(screen.getByLabelText('用户名'), 'existing')
    await user.type(screen.getByLabelText('初始密码'), 'strong-password')
    await user.click(screen.getByRole('button', { name: '创建用户' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('该用户名已存在')
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
