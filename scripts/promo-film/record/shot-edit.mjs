// 画布局部重绘：新建画布，上传批量结果里的赤陶杯，框选多肉换成干花。
// 上传的这张同时是成片擦除对比的改前图，录完复制成 public/img/edit-before.png。
import { BASE, capture, click, debugDir, login, moveTo, open, sleep, type } from './lib.mjs'
import { writeFileSync } from 'node:fs'
const out = new URL('../raw/', import.meta.url).pathname
const dbg = debugDir('edit')
const img = new URL('../public/img/glaze-2.png', import.meta.url).pathname
const { browser, page } = await open()
await login(page)
await page.goto(`${BASE}/image`, { waitUntil: 'domcontentloaded' })
await page.getByRole('combobox', { name: '选择创作方式' }).waitFor()
await sleep(1000)
await page.getByRole('button', { name: '新建画布' }).first().click()
await page.waitForURL(/\/p\//, { timeout: 15000 })
await page.getByRole('button', { name: '上传' }).waitFor()
console.log('canvas', page.url())
await sleep(2000)
let n = 0
const snap = async (tag) => page.screenshot({ path: `${dbg}/${String(++n).padStart(2, '0')}-${tag}.png` })
const t0 = Date.now()
const marks = []
const mark = (k) => {
  marks.push([k, (Date.now() - t0) / 1000])
  console.log('mark', k, ((Date.now() - t0) / 1000).toFixed(1))
}
const stop = await capture(page, out + 'edit.mp4')
try {
  await sleep(800)
  const chooser = page.waitForEvent('filechooser')
  await click(page, page.getByRole('button', { name: '上传' }))
  await (await chooser).setFiles(img)
  // 等图片真正解码出现在画布上
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(() => [...document.querySelectorAll('img')].some((x) => x.naturalWidth >= 700 && x.getBoundingClientRect().width > 150))
    if (ok) break
    await sleep(500)
  }
  await sleep(2500)
  mark('uploaded')
  await snap('uploaded')
  const box = await page.evaluate(() => {
    const big = [...document.querySelectorAll('img')].filter((x) => x.naturalWidth >= 700).sort((a, b) => b.clientWidth - a.clientWidth)[0]
    const r = big.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await moveTo(page, box.x + box.w * 0.6, box.y + box.h * 0.5)
  await sleep(300)
  await page.mouse.down()
  await sleep(70)
  await page.mouse.up()
  await sleep(900)
  await snap('selected')
  const edit = page.getByRole('button', { name: '编辑图片' })
  if (!(await edit.isVisible({ timeout: 4000 }).catch(() => false))) {
    console.log('buttons:', (await page.getByRole('button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label') || x.innerText))).join(' | '))
    throw new Error('no 编辑图片')
  }
  await click(page, edit)
  mark('editor')
  await snap('editor')
  const local = page.getByRole('button', { name: '局部重绘', exact: true })
  await local.waitFor({ timeout: 15000 })
  await click(page, local)
  await sleep(800)
  await snap('local')
  await click(page, page.getByRole('button', { name: '框选', exact: true }))
  const stage = page.locator('canvas').last()
  const sb = await stage.boundingBox()
  console.log('stage', JSON.stringify(sb))
  // 编辑器里图片按正方形居中，用最大的近方形元素定位
  const ib = await page.evaluate(() => {
    const els = [...document.querySelectorAll('img,canvas')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 300 && Math.abs(r.width - r.height) < 20)
    els.sort((a, b) => b.width - a.width)
    const r = els[0]
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
  })
  console.log('image', JSON.stringify(ib))
  const R = ib || { x: sb.x + (sb.width - sb.height) / 2, y: sb.y, width: sb.height, height: sb.height }
  // 多肉和花盆：x 0%–47%，y 12%–62%
  await moveTo(page, R.x + R.width * 0.005, R.y + R.height * 0.12)
  await sleep(300)
  await page.mouse.down()
  for (let i = 1; i <= 30; i++) {
    const t = i / 30
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    await page.mouse.move(R.x + R.width * (0.005 + 0.43 * e), R.y + R.height * (0.12 + 0.5 * e))
    await sleep(16)
  }
  await page.mouse.up()
  mark('masked')
  await sleep(700)
  await snap('masked')
  await type(page, page.getByRole('textbox', { name: /描述希望修改的内容/ }), '把多肉换成一小束干花，插在同一个白色小盆里')
  mark('typed')
  await sleep(600)
  await snap('typed')
  const send = page.getByRole('button', { name: '生成新候选' })
  await click(page, send)
  mark('sent')
  // 画布进度会显示「智能改图中… · 排队中」「保存结果中」等，不能只看「生成中」。
  // 新版本落到节点上时，结果翻页器变成 2 / 2。
  const busy = /生成中|智能改图中|排队中|保存结果中|上传中/
  let done = false
  for (let i = 0; i < 240; i++) {
    if (i % 10 === 0) await snap(`wait${i}`)
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    if (/生成失败|积分不足|未能完成|生成服务异常|不支持遮罩/.test(body)) {
      mark('fail')
      throw new Error(`局部重绘失败：${body.slice(0, 300)}`)
    }
    if (/\b2\s*\/\s*2\b/.test(body) && !busy.test(body)) {
      mark('done')
      done = true
      break
    }
    await sleep(1000)
  }
  if (!done) throw new Error('局部重绘 4 分钟内没有出结果')
  await sleep(3000)
  await snap('result')
  await sleep(4000)
} finally {
  await snap('final')
  writeFileSync(out + 'edit.marks.json', JSON.stringify(marks))
  console.log('url', page.url())
  await stop()
  await browser.close()
}
