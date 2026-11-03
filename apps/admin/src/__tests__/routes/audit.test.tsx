// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const queryState = vi.hoisted(() => ({
  filters: [] as Array<Record<string, string | undefined>>,
}))

vi.mock('../../components/Page', () => ({
  Page: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <main>
      <div>{actions}</div>
      {children}
    </main>
  ),
  EmptyState: ({ label }: { label: string }) => <div>{label}</div>,
  ErrorState: ({ label }: { label: string }) => <div>{label}</div>,
  PendingState: ({ label }: { label: string }) => <div>{label}</div>,
}))
vi.mock('../../components/FuzzyTime', () => ({ FuzzyTime: () => <span>刚刚</span> }))
vi.mock('../../components/ShortId', () => ({
  ShortId: ({ value }: { value: string }) => <span>{value}</span>,
}))
vi.mock('../../hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('../../lib/queries', () => ({
  useAudits: (filters: Record<string, string | undefined>) => {
    queryState.filters.push(filters)
    return {
      data: {
        pages: [
          {
            audits: [
              {
                id: 'audit-1',
                operator_id: 'operator-1',
                action: 'operator_config.set',
                target_type: 'operator_config',
                target_id: 'cli:api',
                details: { reason: 'incident' },
                created_at: Date.now(),
              },
            ],
          },
        ],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    }
  },
}))

import { AuditPage } from '../../routes/_authed.audit'

describe('audit filters', () => {
  it('filters operator config audits by key and target', () => {
    queryState.filters.length = 0
    render(<AuditPage />)
    expect(screen.getByText('设置运营覆盖')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('按配置键筛选'), { target: { value: 'cli:api' } })
    fireEvent.change(screen.getByLabelText('按对象 ID 筛选'), { target: { value: 'cli:api' } })
    const latest = queryState.filters[queryState.filters.length - 1]
    expect(latest).toMatchObject({ settingKey: 'cli:api', targetId: 'cli:api' })
    expect(screen.getByText('operator_config')).toBeInTheDocument()
  })
})
