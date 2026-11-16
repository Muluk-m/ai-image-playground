import type { CSSProperties, ReactNode } from 'react'
import {
  AbsoluteFill,
  Easing,
  Html5Audio,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
} from 'remotion'
import { b, CROP, FPS, MUSIC_FROM, type Rect, S, SRC, TOTAL } from './timeline'

const BG = '#111311'
const FG = '#f6f6f4'
const MUTED = '#a6a9a2'
const FONT = '"PingFang SC", "HarmonyOS Sans SC", system-ui, sans-serif'
const W = 1920
const H = 1080

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const ease = Easing.bezier(0.45, 0, 0.2, 1)

/** 场景：按拍子放到时间线上 */
function Scene({ at, children }: { at: readonly [number, number]; children: ReactNode }) {
  return (
    <Sequence from={b(at[0])} durationInFrames={b(at[1]) - b(at[0])} layout="none">
      <AbsoluteFill style={{ backgroundColor: BG }}>{children}</AbsoluteFill>
    </Sequence>
  )
}

/** 左下角一行说明。只淡入，不位移。 */
function Label({ children, delay = 4, right = false }: { children: ReactNode; delay?: number; right?: boolean }) {
  const f = useCurrentFrame()
  return (
    <div
      style={{
        position: 'absolute',
        ...(right ? { right: 96 } : { left: 96 }),
        bottom: 84,
        fontFamily: FONT,
        fontSize: 30,
        fontWeight: 500,
        letterSpacing: '0.04em',
        color: FG,
        opacity: interpolate(f, [delay, delay + 8], [0, 1], clamp),
      }}
    >
      {children}
    </div>
  )
}

type Key = { t: number; rect: Rect }

/**
 * 录屏镜头：从母带 src 的 from 秒开始，按 rate 倍速播放；
 * keys 按源时间（秒）给出裁切框，相邻两框之间用 14 帧缓动推拉。
 */
function Screen({ src, from, rate, keys }: { src: string; from: number; rate: number; keys: Key[] }) {
  const f = useCurrentFrame()
  const t = from + (f / FPS) * rate
  let rect = keys[0].rect
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i]
    if (t < k.t) break
    const local = ((t - k.t) / rate) * FPS
    const p = ease(Math.min(1, local / 14))
    const a = keys[i - 1].rect
    rect = { x: a.x + (k.rect.x - a.x) * p, y: a.y + (k.rect.y - a.y) * p, w: a.w + (k.rect.w - a.w) * p }
  }
  const s = W / rect.w
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <OffthreadVideo
        src={staticFile(src)}
        trimBefore={Math.round(from * FPS)}
        playbackRate={rate}
        muted
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 2880,
          height: 1620,
          transformOrigin: '0 0',
          transform: `translate(${-rect.x * s}px, ${-rect.y * s}px) scale(${s})`,
        }}
      />
    </AbsoluteFill>
  )
}

/** 居中方图：1080 见方，原图 1254 只缩不放，保持清晰 */
function Square({ src, style }: { src: string; style?: CSSProperties }) {
  return (
    <Img
      src={staticFile(src)}
      style={{ position: 'absolute', left: (W - H) / 2, top: 0, width: H, height: H, objectFit: 'cover', ...style }}
    />
  )
}

const GLAZES = [
  ['img/glaze-1.png', '米白釉'],
  ['img/glaze-2.png', '赤陶釉'],
  ['img/glaze-3.png', '黑釉'],
  ['img/glaze-4.png', '青釉'],
] as const

function Glazes() {
  const f = useCurrentFrame()
  const each = b(2)
  const i = Math.min(3, Math.floor(f / each))
  const [src, name] = GLAZES[i]
  return (
    <>
      <Square src={src} />
      <Sequence from={i * each} layout="none">
        <Label delay={2}>{name}</Label>
      </Sequence>
    </>
  )
}

function Row() {
  const size = 420
  const gap = 20
  const left = (W - (size * 4 + gap * 3)) / 2
  return (
    <>
      {GLAZES.map(([src], i) => (
        <Img
          key={src}
          src={staticFile(src)}
          style={{ position: 'absolute', left: left + i * (size + gap), top: (H - size) / 2, width: size, height: size }}
        />
      ))}
    </>
  )
}

/** 前后对比：竖线从左扫到右，左侧逐渐露出改后的图 */
function Wipe() {
  const f = useCurrentFrame()
  const p = interpolate(f, [b(1), b(3.5)], [0, 1], { ...clamp, easing: ease })
  const x = (W - H) / 2 + H * p
  return (
    <>
      <Square src="img/edit-before.png" />
      <div style={{ position: 'absolute', left: (W - H) / 2, top: 0, width: H * p, height: H, overflow: 'hidden' }}>
        <Img src={staticFile('img/edit-after.png')} style={{ position: 'absolute', left: 0, top: 0, width: H, height: H, objectFit: 'cover' }} />
      </div>
      {p > 0 && p < 1 && <div style={{ position: 'absolute', left: x - 1, top: 0, width: 2, height: H, background: FG }} />}
      <Label delay={b(3.5)}>只改了框选的部分</Label>
    </>
  )
}

const GRID = ['img/glaze-1.png', 'img/glaze-2.png', 'img/glaze-3.png', 'img/glaze-4.png', 'img/edit-after.png', 'img/closeup.png']

function Grid() {
  const f = useCurrentFrame()
  const size = 420
  const gap = 24
  const left = (W - (size * 3 + gap * 2)) / 2
  const top = (H - (size * 2 + gap)) / 2
  return (
    <>
      {GRID.map((src, i) => (
        <Img
          key={src}
          src={staticFile(src)}
          style={{
            position: 'absolute',
            left: left + (i % 3) * (size + gap),
            top: top + Math.floor(i / 3) * (size + gap),
            width: size,
            height: size,
            opacity: interpolate(f, [i * 4, i * 4 + 6], [0, 1], clamp),
          }}
        />
      ))}
    </>
  )
}

function End() {
  const f = useCurrentFrame()
  const o = (d: number) => interpolate(f, [d, d + 12], [0, 1], clamp)
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <Img src={staticFile('brand/muvloom-mark.svg')} style={{ width: 112, height: 112, opacity: o(6) }} />
      <div style={{ marginTop: 36, fontSize: 64, fontWeight: 600, color: FG, letterSpacing: '0.08em', opacity: o(10) }}>幕芽</div>
      <div style={{ marginTop: 18, fontSize: 30, color: MUTED, letterSpacing: '0.04em', opacity: o(18) }}>muvloom.online</div>
    </AbsoluteFill>
  )
}

/** 按场景长度和源区间算倍速 */
const rateFor = (scene: readonly [number, number], from: number, to: number) => (to - from) / ((b(scene[1]) - b(scene[0])) / FPS)

export function Promo() {
  const f = useCurrentFrame()
  const batchTo = SRC.batch.sent + 0.8
  const batchRate = rateFor(S.batchType, SRC.batch.from, batchTo)
  const editTo = SRC.edit.sent + 1.0
  const editRate = rateFor(S.edit, SRC.edit.from, editTo)
  const detailTo = SRC.detail.sent + 0.8
  const detailRate = rateFor(S.detailType, SRC.detail.from, detailTo)
  const fadeIn = interpolate(f, [0, 15], [1, 0], clamp)

  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <Html5Audio
        src={staticFile('music/warm-guitar.mp3')}
        trimBefore={Math.round(MUSIC_FROM * FPS)}
        volume={interpolate(f, [0, 10, TOTAL - 60, TOTAL], [0, 0.9, 0.9, 0], clamp)}
      />

      <Scene at={S.original}>
        <Square src="img/original.png" />
        <Label delay={b(1)}>原图</Label>
      </Scene>

      <Scene at={S.batchType}>
        <Screen src="raw/batch.mp4" from={SRC.batch.from} rate={batchRate} keys={[{ t: 0, rect: CROP.composer }]} />
      </Scene>

      {/* 测试账号同时只能跑 1 张，四张约 3 分钟出齐。不播排队过程，直接切到出齐的画面并标明用时。 */}
      <Scene at={S.batchDone}>
        <Screen src="raw/batch.mp4" from={SRC.batch.done} rate={1} keys={[{ t: 0, rect: CROP.chatDone }]} />
        <Label right delay={6}>3 分钟后</Label>
      </Scene>

      <Scene at={S.glazes}>
        <Glazes />
      </Scene>

      <Scene at={S.row}>
        <Row />
      </Scene>

      <Scene at={S.edit}>
        <Screen
          src="raw/edit.mp4"
          from={SRC.edit.from}
          rate={editRate}
          keys={[
            { t: 0, rect: CROP.full },
            { t: SRC.edit.editor + 0.4, rect: CROP.editorImage },
            { t: SRC.edit.masked + 0.4, rect: CROP.full },
          ]}
        />
      </Scene>

      <Scene at={S.wipe}>
        <Wipe />
      </Scene>

      <Scene at={S.detailType}>
        <Screen src="raw/detail.mp4" from={SRC.detail.from} rate={detailRate} keys={[{ t: 0, rect: CROP.composer }]} />
      </Scene>

      <Scene at={S.closeup}>
        <Square src="img/closeup.png" />
        <Label>杯口特写</Label>
      </Scene>

      <Scene at={S.grid}>
        <Grid />
      </Scene>

      <Scene at={S.end}>
        <End />
      </Scene>

      <AbsoluteFill style={{ backgroundColor: '#000', opacity: fadeIn, pointerEvents: 'none' }} />
    </AbsoluteFill>
  )
}
