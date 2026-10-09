import { expect, it } from 'vitest'
import {
  fitReferenceRow,
  referenceChipChrome,
  referenceFoldChrome,
} from '../../../../features/agent/lib/referenceStrip'

const more = (hidden: number) => 40 + String(hidden).length * 8

it('keeps every chip when the row is wide enough', () => {
  expect(fitReferenceRow(500, [80, 80, 80], more, 6, 8)).toBe(3)
})

it('leaves room for the count chip once the names wrap', () => {
  // Two chips plus "2 more" is 220; three chips plus the count no longer fit in 240.
  expect(fitReferenceRow(240, [80, 80, 80, 80], more, 6, 8)).toBe(2)
})

it('collapses to the count alone when even one chip cannot share the row', () => {
  expect(fitReferenceRow(100, [90, 90], more, 6, 8)).toBe(0)
})

it('uses the fallback count before the panel width is known', () => {
  expect(fitReferenceRow(0, [80, 80, 80, 80, 80], more, 6, 2)).toBe(2)
  expect(fitReferenceRow(0, [80], more, 6, 8)).toBe(1)
})

it('scales the rem parts of chip and fold chrome with the root font size', () => {
  expect(referenceChipChrome(16)).toBe(39)
  expect(referenceFoldChrome(16)).toBe(36)
  expect(referenceChipChrome(20)).toBe(45)
  expect(referenceFoldChrome(20)).toBe(39.5)
})
