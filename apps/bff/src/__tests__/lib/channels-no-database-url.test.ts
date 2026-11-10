import { describe, expect, it } from 'bun:test'

describe('channels import', () => {
  it('imports when DATABASE_URL is unset', async () => {
    const saved = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      const channels = await import('../../lib/channels')
      expect(typeof channels.getDiscoveredChannels).toBe('function')
      expect(typeof channels.parseChannelsConfig).toBe('function')
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })
})
