// 用法: node sniff.mjs <项目URL> <输出目录>  保存页面加载过程中的所有原图响应
import { open, login, sleep } from './lib.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [url, dir] = process.argv.slice(2)
if (!url || !dir) throw new Error('用法: node sniff.mjs <URL> <输出目录>')
mkdirSync(dir, { recursive: true })
let saved = 0
const { browser, page } = await open()
await login(page)
const seen = new Set()
page.on('response', async (r) => {
  const ct = r.headers()['content-type'] || ''
  if (!/image\//.test(ct)) return
  let b
  try {
    b = await r.body()
  } catch {
    return // 重定向、已释放的响应没有响应体
  }
  if (b.length < 300000) return
  const h = createHash('sha1').update(b).digest('hex').slice(0, 8)
  if (seen.has(h)) return
  seen.add(h)
  const f = `${dir}/${h}.${ct.split('/')[1].split(';')[0]}`
  writeFileSync(f, b) // 写入失败直接抛出，不吞掉
  saved++
  console.log(f, b.length, new URL(r.url()).pathname) // 媒体是预签名地址，不打印查询串
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
if (!saved) throw new Error('没有抓到任何原图')
