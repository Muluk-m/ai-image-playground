import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivitySection } from '../../../features/billing/ActivityHeatGraph'
import { bootstrapCapabilities } from './capabilities'

describe('ActivitySection', () => {
  it('renders nothing when billing:credits is off', async () => {
    await bootstrapCapabilities({ 'accounts:login': true })

    expect(renderToStaticMarkup(<ActivitySection />)).toBe('')
  })
})
