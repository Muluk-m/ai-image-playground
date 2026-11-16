// 图片生成：青釉杯参考图 → 杯口特写
import { BASE, capture, click, debugDir, login, moveTo, open, sleep, type } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const out = new URL('../raw/', import.meta.url).pathname
const dbg = debugDir('detail')
const ref = new URL('../public/img/glaze-4.png', import.meta.url).pathname
const { browser, page } = await open()
await login(page)
await page.goto(`${BASE}/image`, { waitUntil: 'domcontentloaded' })
await page.getByRole('combobox', { name: '选择创作方式' }).waitFor()
await sleep(1500)
let n = 0
const snap = async (tag) => page.screenshot({ path: `${dbg}/${String(++n).padStart(2, '0')}-${tag}.png` })
const t0 = Date.now()
const marks = []
const mark = (k) => {
  marks.push([k, (Date.now() - t0) / 1000])
  console.log('mark', k, ((Date.now() - t0) / 1000).toFixed(1))
}
const stop = await capture(page, out + 'detail.mp4')
try {
  await sleep(800)
  const trigger = page.getByRole('combobox', { name: '选择创作方式' })
  if (!((await trigger.innerText()) || '').includes('图片生成')) {
    await click(page, trigger)
    await click(page, page.getByRole('option', { name: '图片生成' }))
  }
  const chooser = page.waitForEvent('filechooser')
  await click(page, page.getByRole('button', { name: '添加参考素材' }))
  const item = page.getByRole('menuitem', { name: '添加图片' }).or(page.getByText('添加图片', { exact: true })).first()
  if (await item.isVisible({ timeout: 1500 }).catch(() => false)) await click(page, item)
  await (await chooser).setFiles(ref)
  await sleep(1800)
  mark('uploaded')
  await type(page, page.getByRole('textbox', { name: '描述你的创意' }), '用这只青釉杯拍一张杯口特写，白天自然光，木桌，画面安静一点')
  mark('typed')
  await sleep(700)
  await snap('typed')
  await click(page, page.getByRole('button', { name: /^(生成|开始创作)/ }).last())
  mark('sent')
  await sleep(4000)
  for (let i = 0; i < 240; i++) {
    if (i % 10 === 0) await snap(`wait${i}`)
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    if (/生成失败|积分不足|未能完成|生成服务异常/.test(body)) {
      mark('fail')
      console.log(body.slice(0, 500))
      break
    }
    if (!/生成中|排队/.test(body) && i > 2) {
      mark('done')
      await sleep(2500)
      await moveTo(page, 1200, 600)
      await sleep(3000)
      break
    }
    await sleep(1000)
  }
} finally {
  await snap('final')
  writeFileSync(out + 'detail.marks.json', JSON.stringify(marks))
  console.log('url', page.url())
  await stop()
  await browser.close()
}
