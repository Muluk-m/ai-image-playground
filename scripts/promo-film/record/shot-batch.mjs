// 智能创作：上传杯子原图，一句话要四种釉色。测试账号同时只跑 1 张，四张约 3 分钟出齐。
import { writeFileSync } from 'node:fs'
import { BASE, capture, click, debugDir, finish, login, moveTo, open, sleep, type } from './lib.mjs'

const out = new URL('../raw/', import.meta.url).pathname
const dbg = debugDir('batch')
const mug = new URL('../../../docs/plans/docs-site-rewrite/mug-1.png', import.meta.url).pathname
const { browser, page } = await open()
await login(page)
await page.goto(`${BASE}/image`, { waitUntil: 'domcontentloaded' })
await page.getByRole('combobox', { name: '选择创作方式' }).waitFor()
await sleep(1500)
const stop = await capture(page, `${out}batch.mp4`)
const t0 = Date.now()
const marks = []
const mark = (k) => {
  marks.push([k, (Date.now() - t0) / 1000])
  console.log('mark', k, ((Date.now() - t0) / 1000).toFixed(1))
}
try {
  await sleep(800)
  await click(page, page.getByRole('combobox', { name: '选择创作方式' }))
  await click(page, page.getByRole('option', { name: /智能创作/ }))
  mark('mode')
  const chooser = page.waitForEvent('filechooser')
  await click(page, page.getByRole('button', { name: '添加参考素材' }))
  const item = page.getByRole('menuitem', { name: '添加图片' }).or(page.getByText('添加图片', { exact: true })).first()
  if (await item.isVisible({ timeout: 1500 }).catch(() => false)) await click(page, item)
  await (await chooser).setFiles(mug)
  await sleep(1800)
  mark('uploaded')
  await type(page, page.getByRole('textbox', { name: '描述你的创意' }), '杯型和场景不变，釉色换成米白、赤陶、黑釉、青釉，各出一张。')
  mark('typed')
  await sleep(700)
  await click(page, page.getByRole('button', { name: /^(生成|开始创作|发送)/ }).last())
  mark('sent')
  let done = false
  for (let i = 0; i < 300; i++) {
    if (i % 5 === 0) await page.screenshot({ path: `${dbg}${String(i).padStart(3, '0')}.png` })
    // 智能体有时会先给生成计划，要点确认才开始
    const confirm = page.getByRole('button', { name: /确认生成|开始生成/ }).first()
    if (await confirm.isVisible().catch(() => false)) {
      mark('plan')
      await click(page, confirm)
    }
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    if (/积分不足|生成失败|未能完成/.test(body)) {
      mark('fail')
      throw new Error(`批量生成失败：${body.slice(0, 300)}`)
    }
    // 发送前创作页的灵感区也有大图，必须已经进了对话页再数
    const n = await page.evaluate(
      () => [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 600 && i.getBoundingClientRect().width > 120).length,
    )
    if (n >= 4 && page.url().includes('/p/')) {
      mark('done')
      done = true
      await sleep(2500)
      await moveTo(page, 1100, 500)
      await sleep(3000)
      break
    }
    await sleep(1000)
  }
  if (!done) throw new Error('四张图 5 分钟内没有出齐')
} finally {
  await finish(browser, stop, async () => {
    writeFileSync(`${out}batch.marks.json`, JSON.stringify(marks))
    console.log('url', page.url())
    await page.screenshot({ path: `${dbg}final.png` })
  })
}
