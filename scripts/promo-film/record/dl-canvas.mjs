// 用法: node dl-canvas.mjs <画布URL> <输出文件>  选中画布上的图片并用工具栏下载原图
import { open, login, sleep } from './lib.mjs'
const [url, dest] = process.argv.slice(2)
const { browser, page } = await open()
await login(page)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '上传' }).waitFor()
await sleep(5000)
const box = await page.evaluate(() => {
  const big = [...document.querySelectorAll('img')].filter((x) => x.getBoundingClientRect().width > 150).sort((a, b) => b.clientWidth - a.clientWidth)[0]
  const r = big.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
await page.mouse.click(box.x, box.y)
await sleep(1000)
const btn = page.getByRole('button', { name: /下载/ }).first()
const dl = page.waitForEvent('download', { timeout: 30000 })
await btn.click()
const d = await dl
await d.saveAs(dest)
console.log('saved', dest, d.suggestedFilename())
await browser.close()
