/**
 * 把 scripts/docs-videos/raw 里的录像压成指南成片：
 * H.264 MP4、VP9 WebM、WebP 封面。不读凭据。
 * 视频写到 scripts/docs-videos/out/（gitignore）。封面仍写到 public。
 * 这是旧的低码率路径，不要再用它盖掉 finish.py 的成片。宣传片见 scripts/promo-film/。
 *
 *   node scripts/docs-videos/encode.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const raw = resolve(root, 'scripts/docs-videos/raw')
const out = resolve(root, 'scripts/docs-videos/out')
const posters = resolve(root, 'apps/web/public/guide-assets/zh/clips')
mkdirSync(out, { recursive: true })
mkdirSync(posters, { recursive: true })

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
  const poster = resolve(posters, `${name}-poster.webp`)
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
