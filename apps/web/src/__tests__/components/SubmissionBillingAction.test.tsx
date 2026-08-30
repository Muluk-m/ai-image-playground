import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SubmissionBillingAction from '../../components/SubmissionBillingAction'

describe('SubmissionBillingAction', () => {
  it('renders nothing when submission is allowed', () => {
    expect(renderToStaticMarkup(<SubmissionBillingAction />)).toBe('')
  })

  it('shows the payment action when submission is blocked', () => {
    const html = renderToStaticMarkup(
      <SubmissionBillingAction blockedAction={{ label: '充值积分', run: () => {} }} />,
    )

    expect(html).toContain('<button')
    expect(html).toContain('充值积分')
  })
})
