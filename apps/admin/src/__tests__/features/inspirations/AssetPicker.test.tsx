import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ReferenceImageFields } from '../../../features/inspirations/AssetPicker'

describe('ReferenceImageFields', () => {
  it('attaches an existing HTTPS image with its visible name', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ReferenceImageFields value={[]} onChange={onChange} />)

    await user.type(screen.getByRole('textbox', { name: '已有图片的素材名' }), '旅行原图')
    await user.type(
      screen.getByRole('textbox', { name: '已有图片的 https 地址' }),
      'https://muvloom-inspiration-assets.deepclick.com/travel.png',
    )
    await user.click(screen.getByRole('button', { name: '引用已有图片' }))

    expect(onChange).toHaveBeenCalledWith([
      {
        key: 'https://muvloom-inspiration-assets.deepclick.com/travel.png',
        name: '旅行原图',
      },
    ])
  })

  it('rejects insecure and duplicate references', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ReferenceImageFields
        value={[
          {
            key: 'https://muvloom-inspiration-assets.deepclick.com/source.png',
            name: '已有原图',
          },
        ]}
        onChange={onChange}
      />,
    )

    await user.type(screen.getByRole('textbox', { name: '已有图片的素材名' }), '另一张')
    const url = screen.getByRole('textbox', { name: '已有图片的 https 地址' })
    await user.type(url, 'http://muvloom-inspiration-assets.deepclick.com/source.png')
    await user.click(screen.getByRole('button', { name: '引用已有图片' }))
    expect(screen.getByText('填写素材名及本站公开素材的 https 地址')).toBeInTheDocument()

    await user.clear(url)
    await user.type(url, 'https://muvloom-inspiration-assets.deepclick.com/source.png')
    await user.click(screen.getByRole('button', { name: '引用已有图片' }))
    expect(screen.getByText('这张参考图已经添加')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects malformed hosts and third-party images without verified CORS', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ReferenceImageFields value={[]} onChange={onChange} />)

    await user.type(screen.getByRole('textbox', { name: '已有图片的素材名' }), '坏地址')
    const url = screen.getByRole('textbox', { name: '已有图片的 https 地址' })
    await user.type(url, 'https:///')
    await user.click(screen.getByRole('button', { name: '引用已有图片' }))
    expect(onChange).not.toHaveBeenCalled()

    await user.clear(url)
    await user.type(url, 'https://example.com/source.png')
    await user.click(screen.getByRole('button', { name: '引用已有图片' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
