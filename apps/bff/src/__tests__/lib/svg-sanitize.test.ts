import { describe, expect, it } from 'bun:test'
import { sanitizeSvg } from '../../lib/svg-sanitize'

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

const CLEAN = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path fill="#35190f" d="M1 1h2"/>
  <use href="#mark"/>
</svg>`

describe('sanitizeSvg', () => {
  it('keeps a static vector document', () => {
    expect(decode(sanitizeSvg(encode(CLEAN)))).toContain('<path')
    expect(decode(sanitizeSvg(encode(CLEAN)))).toContain('href="#mark"')
  })

  it('strips scripts, event handlers and external links', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script>
      <a href="https://evil.example/x">x</a>
      <image href="https://evil.example/a.png"/>
      <path d="M0 0"/>
    </svg>`
    const cleaned = decode(sanitizeSvg(encode(dirty)))
    expect(cleaned).not.toContain('script')
    expect(cleaned).not.toContain('onload')
    expect(cleaned).not.toContain('https://')
    expect(cleaned).toContain('<path')
  })

  it('strips a script tag that was split around another script tag', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><scr<script>alert(1)</script>ipt>alert(2)</script><path d="M0 0"/></svg>`
    const cleaned = decode(sanitizeSvg(encode(dirty)))
    expect(cleaned.toLowerCase()).not.toContain('script')
    expect(cleaned).toContain('<path')
  })

  it('rejects a payload that is not an svg document', () => {
    expect(() => sanitizeSvg(encode('<html><script>alert(1)</script></html>'))).toThrow(
      'svg_not_document',
    )
  })
})
