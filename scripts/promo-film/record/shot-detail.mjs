// 图片生成：青釉杯参考图 → 杯口特写
import { BASE, capture, click, debugDir, finish, login, moveTo, open, sleep, type } from './lib.mjs'
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
  const cardIds = () => page.evaluate(() => [...document.querySelectorAll('[data-task-id]')].map((card) => card.getAttribute('data-task-id')))
  const before = new Set(await cardIds())
  await click(page, page.getByRole('button', { name: /^(生成|开始创作)/ }).last())
  mark('sent')
  // 完成 = 出现一张新作品卡片，结果图已解码，卡片上没有任何进行中的阶段文案
  let done = false
  for (let i = 0; i < 240; i++) {
    if (i % 10 === 0) await snap(`wait${i}`)
    const fresh = await page.evaluate(
      (known) =>
        [...document.querySelectorAll('[data-task-id]')]
          .filter((card) => !known.includes(card.getAttribute('data-task-id')))
          .map((card) => ({
            text: card.textContent.replace(/\s+/g, ' '),
            // 卡片里还有模型图标；结果图带 data-image-id，只在任务有输出时渲染
            decoded: [...card.querySelectorAll('img[data-image-id]')].some((img) => img.complete && img.naturalWidth > 0),
          })),
      [...before],
    )
    // 失败的卡片只显示「失败」，具体原因在失败后弹出的详情里，所以连同整页文案一起报
    const failed = fresh.find((card) => /失败|积分不足|未能完成/.test(card.text))
    if (failed) {
      mark('fail')
      await sleep(1500)
      const pageText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
      const reason = pageText.match(/[^。]*(生成服务异常|未能完成|积分不足|失败)[^。]*。?/)?.[0] ?? ''
      throw new Error(`特写生成失败：${reason || failed.text.slice(0, 200)}`)
    }
    const busy = /生成中|排队|已提交|保存结果中|载入结果|重新连接中|恢复连接中|结果确认中|上传中/
    if (fresh.some((card) => card.decoded && !busy.test(card.text))) {
      mark('done')
      done = true
      await sleep(2500)
      await moveTo(page, 1200, 600)
      await sleep(3000)
      break
    }
    await sleep(1000)
  }
  if (!done) throw new Error('特写 4 分钟内没有出结果')
} finally {
  await finish(browser, stop, async () => {
    writeFileSync(`${out}detail.marks.json`, JSON.stringify(marks))
    console.log('url', page.url())
    await snap('final')
  })
}
