/**
 * 把 scripts/docs-videos/raw 里的录像压成指南成片：
 * H.264 MP4、VP9 WebM、WebP 封面。不读凭据。
 *
 *   node scripts/docs-videos/encode.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const raw = resolve(root, 'scripts/docs-videos/raw')
const out = resolve(root, 'apps/web/public/guide-assets/zh/clips')
mkdirSync(out, { recursive: true })
const font = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'

function run(args) {
  const result = spawnSync('ffmpeg', ['-y', ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
}

function cut(input, output, filter) {
  run(['-i', input, '-filter_complex', filter, '-map', '[v]', '-an', '-c:v', 'libvpx', '-b:v', '800k', output])
}

const cuts = {
  '06-batch-each': {
    src: resolve(raw, '06.webm'),
    filter:
      '[0:v]trim=0:22,setpts=PTS-STARTPTS[a];[0:v]trim=155:194,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]',
  },
  '07-agent-chat': {
    src: resolve(raw, '07.webm'),
    filter: '[0:v]trim=18:98,setpts=PTS-STARTPTS[v]',
  },
}

const straight = {
  '01-first-image': resolve(raw, '01.webm'),
  '02-reference-image': resolve(raw, '02.webm'),
  '03-generation-settings': resolve(raw, '03.webm'),
  '04-gpt26-gif': resolve(raw, '04.webm'),
  '05-gpt26-svg': resolve(raw, '05.webm'),
  '10-explore-remix': resolve(raw, '10.webm'),
  '11-toolbox-crop': resolve(raw, '11.webm'),
  '09-canvas-inpaint': resolve(raw, '09.webm'),
}

function encodePair(name, src) {
  const mp4 = resolve(out, `${name}.mp4`)
  const webm = resolve(out, `${name}.webm`)
  const poster = resolve(out, `${name}-poster.webp`)
  run([
    '-i', src,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '32', '-preset', 'veryfast',
    '-movflags', '+faststart', mp4,
  ])
  run(['-i', src, '-an', '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-cpu-used', '4', webm])
  run(['-ss', '1.2', '-i', src, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '72', poster])
  const mb = (path) => (statSync(path).size / 1024 / 1024).toFixed(2)
  console.log(`${name} mp4=${mb(mp4)}MiB webm=${mb(webm)}MiB`)
}

for (const [name, job] of Object.entries(cuts)) {
  const tmp = resolve(raw, `${name}.cut.webm`)
  cut(job.src, tmp, job.filter)
  encodePair(name, tmp)
}
for (const [name, src] of Object.entries(straight)) {
  try {
    statSync(src)
  } catch {
    console.log(`skip missing ${name}`)
    continue
  }
  encodePair(name, src)
}

const promoSrc = [
  { file: resolve(raw, '01.webm'), start: 6, dur: 8, text: '说出画面，幕芽成片' },
  { file: resolve(raw, '01.webm'), start: 36, dur: 12, text: '一句话，出一张能用的图' },
  { file: resolve(raw, '02.webm'), start: 38, dur: 12, text: '加上参考图，商品还是你的' },
  { file: resolve(raw, '07-agent-chat.cut.webm'), start: 40, dur: 12, text: '需求还含糊时，交给智能体' },
  { file: resolve(raw, '03.webm'), start: 48, dur: 10, text: '同一设置，可以出两张' },
  { file: resolve(raw, '06-batch-each.cut.webm'), start: 40, dur: 10, text: '逐张换背景，商品还在' },
]

const listPath = resolve(raw, 'promo-concat.txt')
const segments = []
promoSrc.forEach((item, index) => {
  const seg = resolve(raw, `promo-seg-${index}.mp4`)
  const draw = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,drawtext=fontfile=${font}:text='${item.text}':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-120`
  run([
    '-ss', String(item.start), '-t', String(item.dur), '-i', item.file,
    '-vf', draw, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', seg,
  ])
  segments.push(seg)
})
const card = resolve(raw, 'promo-end.mp4')
run([
  '-f', 'lavfi', '-i', 'color=c=0x111311:s=1920x1080:d=6',
  '-vf',
  `drawtext=fontfile=${font}:text='幕芽':fontsize=84:fontcolor=white:x=(w-text_w)/2:y=(h/2)-70,drawtext=fontfile=${font}:text='muvloom.online':fontsize=42:fontcolor=white:x=(w-text_w)/2:y=(h/2)+30`,
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', card,
])
segments.push(card)
const { writeFileSync } = await import('node:fs')
writeFileSync(listPath, segments.map((file) => `file '${file}'`).join('\n'))
const promo = resolve(out, 'promo-site-zh.mp4')
run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', promo])
run(['-i', promo, '-an', '-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-cpu-used', '4', resolve(out, 'promo-site-zh.webm')])
run(['-ss', '8', '-i', promo, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '72', resolve(out, 'promo-site-zh-poster.webp')])
console.log('promo bytes', statSync(promo).size)
