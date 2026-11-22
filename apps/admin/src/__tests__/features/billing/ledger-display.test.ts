import { describe, expect, it } from 'vitest'
import { visibleLedger } from '../../../features/billing/ledger-display'

describe('visibleLedger', () => {
  it('hides settlements that moved nothing and says how many it hid', () => {
    const { shown, hidden } = visibleLedger([
      { amount: -100, note: null },
      { amount: 0, note: null },
      { amount: 0, note: '  ' },
      { amount: 40, note: null },
    ])
    expect(shown.map((entry) => entry.amount)).toEqual([-100, 40])
    expect(hidden).toBe(2)
  })

  it('keeps a zero entry that carries a note: the note is the information', () => {
    const { shown, hidden } = visibleLedger([{ amount: 0, note: '66000 套餐积分已过期，未退回' }])
    expect(shown).toHaveLength(1)
    expect(hidden).toBe(0)
  })
})
