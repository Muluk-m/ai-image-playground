import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SubmissionCostEstimate from '../../components/SubmissionCostEstimate'

describe('SubmissionCostEstimate', () => {
  it('shows the current model price multiplied by the requested image count', () => {
    const html = renderToStaticMarkup(<SubmissionCostEstimate credits={300} />)

    expect(html).toContain('本次 300 积分')
  })

  it('renders nothing when the deployment does not supply a price', () => {
    expect(renderToStaticMarkup(<SubmissionCostEstimate />)).toBe('')
  })

  it('shows the payment action at the blocked submission cost', () => {
    const html = renderToStaticMarkup(
      <SubmissionCostEstimate credits={300} blockedAction={{ label: '充值积分', run: () => {} }} />,
    )

    expect(html).toContain('<button')
    expect(html).toContain('充值积分')
  })
})
