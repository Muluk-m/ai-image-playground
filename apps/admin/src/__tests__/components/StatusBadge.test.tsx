// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from '../../components/StatusBadge'

describe('StatusBadge', () => {
  it('renders the canonical cancelled task status', () => {
    render(<StatusBadge status="cancelled" />)
    expect(screen.getByText('已取消')).toBeInTheDocument()
  })
})
