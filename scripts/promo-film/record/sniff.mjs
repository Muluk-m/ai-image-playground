// 用法: node sniff.mjs <项目URL> <输出目录>  保存页面加载过程中的所有原图响应
import { open, login, sleep } from './lib.mjs'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [url, dir] = process.argv.slice(2)
const { browser, page } = await open()
await login(page)
const seen = new Set()
page.on('response', async (r) => {
  const ct = r.headers()['content-type'] || ''
  if (!/image\//.test(ct)) return
  try {
    const b = await r.body()
    if (b.length < 300000) return
    const h = createHash('sha1').update(b).digest('hex').slice(0, 8)
    if (seen.has(h)) return
    seen.add(h)
    const f = `${dir}/${h}.${ct.split('/')[1].split(';')[0]}`
    writeFileSync(f, b)
    console.log(f, b.length, r.url().slice(0, 100))
  } catch {}
})
await page.goto(url, { waitUntil: 'domcontentloaded' })
await sleep(6000)
if (process.env.OPEN_FIRST === '1') {
  await page.locator('[data-task-id]').first().locator('img').first().click()
  await sleep(8000)
}
await page.mouse.wheel(0, -4000)
await sleep(4000)
await browser.close()
