import { describe, expect, it } from 'bun:test'
import {
  BIO_MAX_LENGTH,
  bioError,
  DEFAULT_AVATAR_PATH,
  NICKNAME_MAX_LENGTH,
  nicknameError,
} from '../auth'

describe('nickname', () => {
  it('accepts a 2–20 character display name', () => {
    expect(nicknameError('青柚')).toBeNull()
    expect(nicknameError('青柚工作室')).toBeNull()
    expect(nicknameError('a'.repeat(NICKNAME_MAX_LENGTH))).toBeNull()
  })

  it('rejects names that are too short, too long, or contain controls', () => {
    expect(nicknameError('芽')).toBe('nickname_invalid')
    expect(nicknameError(`  ${'芽'.repeat(NICKNAME_MAX_LENGTH + 1)}  `)).toBe('nickname_invalid')
    expect(nicknameError('青\n柚')).toBe('nickname_invalid')
    expect(nicknameError('   ')).toBe('nickname_invalid')
  })

  it('rejects impersonation words even when whitespace splits them', () => {
    expect(nicknameError('官方')).toBe('nickname_blocked')
    expect(nicknameError('客服小助手')).toBe('nickname_blocked')
    expect(nicknameError('客 服')).toBe('nickname_blocked')
    expect(nicknameError('我是官方号')).toBe('nickname_blocked')
  })
})

describe('bio', () => {
  it('treats a blank bio as clearing it', () => {
    expect(bioError('')).toBeNull()
    expect(bioError('   ')).toBeNull()
  })

  it('accepts 120 characters and rejects anything longer or with a newline', () => {
    expect(bioError('a'.repeat(BIO_MAX_LENGTH))).toBeNull()
    expect(bioError('芽'.repeat(BIO_MAX_LENGTH))).toBeNull()
    expect(bioError('a'.repeat(BIO_MAX_LENGTH + 1))).toBe('bio_invalid')
    expect(bioError('第一行\n第二行')).toBe('bio_invalid')
  })
})

describe('default avatar', () => {
  it('points at the sprout shipped with the web app', () => {
    expect(DEFAULT_AVATAR_PATH).toBe('/brand/avatar-artist-192.png')
  })
})
