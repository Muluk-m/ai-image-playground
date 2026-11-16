import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

export const BASE = 'https://test.muvloom.online'
export const W = 1440, H = 810, DPR = 2
/** 调试截图目录：raw/debug/<镜头名> */
export function debugDir(name) {
  const dir = new URL(`../raw/debug/${name}/`, import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  return dir
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CURSOR = `(() => {
  const id='rec-cursor'
  const paint=()=>{ if(document.getElementById(id))return
    const s=document.createElement('style'); s.textContent='#'+id+'{position:fixed;z-index:2147483647;width:20px;height:20px;margin:-2px 0 0 -2px;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));transition:transform .08s}#'+id+'.down{transform:scale(.86)}'
    const n=document.createElement('div'); n.id=id
    n.innerHTML='<svg width="20" height="20" viewBox="0 0 18 18"><path d="M2 1.5 L2 14.5 L5.6 11.2 L8.1 16.2 L10.2 15.2 L7.6 10.2 L12.6 10.2 Z" fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/></svg>'
    document.documentElement.append(s,n)}
  addEventListener('mousemove',e=>{paint();const n=document.getElementById(id);if(!n)return;n.style.left=e.clientX+'px';n.style.top=e.clientY+'px'},true)
  addEventListener('mousedown',()=>document.getElementById(id)?.classList.add('down'),true)
  addEventListener('mouseup',()=>document.getElementById(id)?.classList.remove('down'),true)
})()`

export async function open({ headless = true } = {}) {
  // 屏幕采集按真实窗口的绘制表面出帧：不模拟视口，窗口加 87px 顶栏，强制 2 倍像素
  const browser = await chromium.launch({ channel: 'chrome', headless, args: [`--window-size=${W},${H + 87}`, `--force-device-scale-factor=${DPR}`] })
  const ctx = await browser.newContext({ viewport: null, locale: 'zh-CN', colorScheme: 'dark' })
  await ctx.addInitScript(CURSOR)
  const page = await ctx.newPage()
  return { browser, ctx, page }
}

export async function login(page) {
  await page.goto(`${BASE}/login/`, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('邮箱地址').fill(process.env.PROMO_EMAIL)
  await page.locator('input[name="password"]').fill(process.env.PROMO_PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(/\/image/, { timeout: 30000 })
  await sleep(1500)
}

let mx = W / 2, my = H / 2
export async function moveTo(page, x, y, steps = 24) {
  // ease-in-out 轨迹，比线性移动更像人手
  const sx = mx, sy = my
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e)
    await sleep(12)
  }
  mx = x; my = y
}
export async function point(page, loc, dx = .5, dy = .5) {
  await loc.waitFor({ state: 'visible', timeout: 20000 })
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  const x = b.x + b.width * dx, y = b.y + b.height * dy
  await moveTo(page, x, y)
  await sleep(250)
  return { x, y }
}
export async function click(page, loc) {
  const { x, y } = await point(page, loc)
  await page.mouse.down(); await sleep(70); await page.mouse.up()
  await sleep(450)
}
export async function type(page, loc, text, delay = 70) {
  await click(page, loc)
  // 中文逐字，标点后多停一下
  for (const ch of text) {
    await page.keyboard.insertText(ch)
    await sleep(/[，。、,.]/.test(ch) ? delay * 4 : delay + Math.random() * 40)
  }
}

/** CDP 逐帧采集，按墙钟补帧到 30fps，CRF 14 母带 */
export async function capture(page, dest) {
  const client = await page.context().newCDPSession(page)
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-vcodec', 'mjpeg', '-i', 'pipe:0', '-an',
    '-vf', `scale=${W * DPR}:${H * DPR}:force_original_aspect_ratio=decrease,pad=${W * DPR}:${H * DPR}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', '-preset', 'veryfast', '-movflags', '+faststart', dest], { stdio: ['pipe', 'ignore', 'inherit'] })
  ff.stdin.on('error', () => {})
  const step = 1000 / 30
  let due = 0, last = null, closed = false
  const done = new Promise((r) => ff.on('close', r))
  client.on('Page.screencastFrame', (evt) => {
    if (closed) return
    client.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => {})
    const f = Buffer.from(evt.data, 'base64'), now = Date.now()
    if (!due) due = now
    while (last && due <= now - step) { ff.stdin.write(last); due += step }
    last = f
    if (due <= now + 1) { ff.stdin.write(f); due += step }
  })
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W * DPR, maxHeight: H * DPR, everyNthFrame: 1 })
  // 静止画面 Chrome 不发帧，定时补
  const pump = setInterval(() => { if (!closed && last) { const now = Date.now(); while (due <= now) { ff.stdin.write(last); due += step } } }, 100)
  return async () => {
    closed = true; clearInterval(pump)
    await client.send('Page.stopScreencast').catch(() => {})
    ff.stdin.end(); await done
  }
}
