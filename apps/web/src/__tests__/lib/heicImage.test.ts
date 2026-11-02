// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { isHeicFile } from '../../lib/heicImage'

it.each([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
])('recognizes %s even without a file extension', (type) =>
  expect(isHeicFile(new File(['bytes'], 'photo', { type }))).toBe(true))

it.each(['', 'application/octet-stream'])('recognizes phone extensions with MIME %s', (type) => {
  expect(isHeicFile(new File(['bytes'], 'PHOTO.HEIC', { type }))).toBe(true)
  expect(isHeicFile(new File(['bytes'], 'photo.HeIf', { type }))).toBe(true)
  expect(isHeicFile(new File(['bytes'], 'photo.heic.txt', { type }))).toBe(false)
  expect(isHeicFile(new File(['bytes'], 'photo', { type }))).toBe(false)
})

it.each([
  'text/plain',
  'application/pdf',
  'image/jpeg',
])('does not override an explicit %s type using a misleading filename', (type) =>
  expect(isHeicFile(new File(['bytes'], 'photo.heic', { type }))).toBe(false))
