import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { accountNavItems } from '../../../features/billing/AccountPanel'
import { AccountSettings } from '../../../features/billing/AccountSettings'
import { AvatarCropFrame } from '../../../features/billing/AvatarCropDialog'
import { clampCropOffset, coverScale } from '../../../features/billing/avatar-crop'
import { i18next } from '../../../lib/privateHost'
import '../../../features/billing/i18n'
import {
  bioIssue,
  describeSessions,
  nicknameIssue,
  parseLoginMethods,
  parseProfile,
  parseSessions,
  profilePaths,
  resolveAvatarUrl,
} from '../../../features/billing/profile-client'

beforeAll(async () => {
  await i18next.changeLanguage('zh-CN')
})

describe('account navigation', () => {
  it('puts 账户设置 second and uses the security icon', () => {
    expect(accountNavItems.map(([id, , icon]) => [id, icon])).toEqual([
      ['overview', 'user'],
      ['settings', 'security'],
      ['billing', 'list'],
      ['referrals', 'share'],
    ])
  })
})

describe('profile client', () => {
  it('matches the server nickname and bio rules', () => {
    expect(nicknameIssue('  ')).toBe('empty')
    expect(nicknameIssue('芽')).toBe('invalid')
    expect(nicknameIssue('芽'.repeat(21))).toBe('invalid')
    expect(nicknameIssue('官方客服')).toBe('blocked')
    expect(nicknameIssue('客 服')).toBe('blocked')
    expect(nicknameIssue('青柚工作室')).toBeNull()
    expect(bioIssue('')).toBeNull()
    expect(bioIssue(`芽\n芽`)).toBe('invalid')
    expect(bioIssue('芽'.repeat(121))).toBe('invalid')
    expect(bioIssue('一句话')).toBeNull()
  })

  it('reads the profile contract, including /api/auth/me', () => {
    expect(
      parseProfile({
        id: 'user-1',
        username: 'qingyou@studio.cn',
        nickname: '青柚',
        bio: null,
        avatar_url: '/brand/avatar-artist-192.png',
        avatar_is_default: true,
      }),
    ).toMatchObject({
      userId: 'user-1',
      username: 'qingyou@studio.cn',
      nickname: '青柚',
      bio: null,
      avatarUrl: null,
      avatarIsDefault: true,
    })

    expect(
      parseProfile({
        id: 'user-2',
        username: 'qingyou',
        nickname: '青柚',
        bio: '工作室',
        avatar_url: '/api/avatars/user-2?v=10',
        avatar_is_default: false,
      }).avatarUrl,
    ).toBe(resolveAvatarUrl('/api/avatars/user-2?v=10', false))

    expect(
      parseProfile({
        user: {
          id: 'user-3',
          username: 'qingyou@studio.cn',
          nickname: null,
          bio: null,
          avatar_url: '/brand/avatar-artist-192.png',
          avatar_is_default: true,
        },
      }),
    ).toMatchObject({ userId: 'user-3', avatarIsDefault: true, avatarUrl: null })
  })

  it('finds the Google identity and summarizes other devices', () => {
    expect(
      parseLoginMethods({
        password: true,
        identities: [{ provider: 'google', email: 'qingyou@gmail.com', linked_at: 1 }],
      }).google,
    ).toEqual({ linked: true, email: 'qingyou@gmail.com' })

    const sessions = parseSessions({
      sessions: [
        {
          current: true,
          user_agent: 'Mozilla Chrome',
          device_label: 'Chrome · macOS',
          ip: '203.0.113.10',
          created_at: 1,
          last_active_at: 2,
        },
        {
          current: false,
          user_agent: null,
          device_label: 'Safari · iOS',
          ip: null,
          created_at: 1,
          last_active_at: 1,
        },
      ],
    })
    expect(describeSessions(sessions)).toEqual({ label: 'Chrome · macOS', others: 1 })
    expect(profilePaths.deleteAccount).toBe('/api/me')
    expect(profilePaths.avatar).toBe('/api/me/avatar')
    expect(profilePaths.revokeOthers).toBe('/api/me/sessions/revoke-others')
  })
})

describe('avatar crop', () => {
  it('clamps the pan so the circle stays inside the image', () => {
    const size = { width: 1000, height: 500 }
    expect(coverScale(size, 240, 0)).toBeCloseTo(0.48)
    expect(clampCropOffset({ x: 999, y: 999 }, size, 240, 1, 0)).toEqual({ x: 120, y: 0 })
    expect(clampCropOffset({ x: 999, y: 999 }, size, 240, 1, 90)).toEqual({ x: 0, y: 120 })
  })
})

function renderSettings(preview: 'default' | 'crop' | 'error' | 'saving' | 'success'): string {
  return renderToStaticMarkup(
    <AccountSettings username="qingyou@studio.cn" preview={preview} onAccountDeleted={() => {}} />,
  )
}

describe('account settings states', () => {
  it('shows the sprout, nickname and verified email by default', () => {
    const html = renderSettings('default')
    expect(html).toContain('data-settings-phase="default"')
    expect(html).toContain('src="/brand/avatar-artist-192.png"')
    expect(html).not.toContain('默认头像')
    expect(html).toContain('JPG / PNG / WebP · ≤ 5MB，上传后可裁剪')
    expect(html).toContain('青柚工作室')
    expect(html).not.toContain('u_8f73a2e9q')
    expect(html).not.toContain('用户 ID')
    expect(html).toContain('已验证')
    expect(html).toContain('退出其他设备')
    expect(html).toContain('注销账号')
  })

  it('shows the crop dialog chrome', () => {
    const html = renderSettings('crop')
    expect(html).toContain('裁剪头像')
    expect(html).toContain('使用此头像')
    expect(html).toContain('data-crop-layout="dialog"')
  })

  it('shows a nickname validation error', () => {
    const html = renderSettings('error')
    expect(html).toContain('data-settings-phase="error"')
    expect(html).toContain('昵称不能包含「官方」「客服」等字样')
    expect(html).toContain('aria-invalid="true"')
  })

  it('shows a saving state on the nickname', () => {
    const html = renderSettings('saving')
    expect(html).toContain('data-settings-phase="saving"')
    expect(html).toContain('保存中')
  })

  it('shows a success toast and the uploaded avatar', () => {
    const html = renderSettings('success')
    expect(html).toContain('data-settings-phase="success"')
    expect(html).toContain('头像已更新')
    expect(html).toContain('自定义头像')
    expect(html).toContain('已保存')
    expect(html).not.toContain('src="/brand/avatar-artist-192.png"')
  })

  it('renders the cropper as a bottom sheet on mobile', () => {
    const html = renderToStaticMarkup(
      <AvatarCropFrame
        imageUrl="/preview.png"
        sheet
        saving={false}
        onClose={() => {}}
        onReselect={() => {}}
        onConfirm={() => {}}
        onError={() => {}}
      />,
    )
    expect(html).toContain('data-crop-layout="sheet"')
    expect(html).toContain('rounded-t-3xl')
  })
})
