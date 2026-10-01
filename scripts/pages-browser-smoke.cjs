const { chromium } = require('playwright')

;(async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: 'zh-CN' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.locator('[aria-label="创作"]').waitFor({ timeout: 60000 })
    await page.locator('#boot').waitFor({ state: 'detached', timeout: 10000 })
    await page.screenshot({ path: 'pages-startup.png' })
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('Production workspace mounted without JavaScript errors')
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exitCode = 1 })
