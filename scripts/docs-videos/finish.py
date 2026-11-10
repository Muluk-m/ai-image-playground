#!/usr/bin/env python3
"""从 1080p 母带剪指南成片和宣传片。

指南片：等待段 8–16 倍快进，只留约两秒，CRF 18，无营销字幕。
宣传片：片头片尾、圆角字幕、推近，45–60 秒，CRF 18。
母带在 scripts/docs-videos/raw/hd/。不要用已经压过的 clips 当输入。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
HD = ROOT / "scripts/docs-videos/raw/hd"
OUT = ROOT / "apps/web/public/guide-assets/zh/clips"
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_INDEX = 2  # Noto Sans CJK SC Bold。0 是日文，2 才是简体。
W, H = 1920, 1080
FPS = 30

# 宣传片字幕。逐字核对过，「糊」不是「树」。
SUBS = {
    "open": "说出画面，幕芽成片",
    "one": "一句话，出一张能用的图",
    "ref": "加上参考图，商品还是你的",
    "agent": "需求还含糊时，交给智能体",
    "two": "同一设置，可以出两张",
    "batch": "逐张换背景，商品还在",
}
assert SUBS["agent"] == "需求还含糊时，交给智能体"
assert "糊" in SUBS["agent"] and "树" not in SUBS["agent"]
assert SUBS["open"] == "说出画面，幕芽成片"
assert SUBS["one"] == "一句话，出一张能用的图"
assert SUBS["ref"] == "加上参考图，商品还是你的"
assert SUBS["two"] == "同一设置，可以出两张"
assert SUBS["batch"] == "逐张换背景，商品还在"

GUIDE = {
    "01": "01-first-image",
    "02": "02-reference-image",
    "03": "03-generation-settings",
    "06": "06-batch-each",
    "07": "07-agent-chat",
    "08": "08-video",
}
# 成果已经出现的时刻（对过母带帧）。这一刻起保持原速，并在 2.3 秒后收尾。
REVEAL = {
    "01": 40.55,
    "02": 60.55,
    "03": 51.15,
    "06": 78.2,
    "07": 65.0,
    # 节点出现「生成失败」，顶部同时有「该模型暂不可用，请换其他模型」。
    "08": 37.6,
}
HOLD = 2.3
# 暗界面上的点击差分太小，自动等待检测会把选模式、设置和点生成整段快进。
# 这些时刻对过母带帧，只保留能看清的操作，中间的空等剪掉。
MANUAL = {
    "08": [
        (3.6, 5.2, 1),
        (7.4, 10.2, 1),
        (13.2, 15.6, 1),
        (16.2, 21.4, 8),
        (21.4, 23.2, 1),
        (28.8, 32.4, 1),
        (33.6, 37.2, 1),
        (37.5, 41.2, 1),
    ],
}

# (shot, start, source_dur, speed, cx, cy, zoom, subtitle key or None)
# 播放时长 = source_dur / speed。zoom 为 0 表示不推近。
PROMO_SCENES: list[tuple] = [
    ("01", 13.0, 4.4, 1, 960, 410, 0.50, "one"),
    ("01", 26.2, 14.4, 8, 0, 0, 0, None),
    ("01", 40.6, 2.2, 1, 760, 640, 1.05, "one"),
    ("02", 12.0, 3.2, 1, 960, 400, 0.52, "ref"),
    ("02", 36.5, 24.0, 16, 0, 0, 0, None),
    ("02", 60.6, 2.2, 1, 760, 640, 1.05, "ref"),
    ("07", 24.0, 3.4, 1, 1080, 280, 0.36, "agent"),
    ("07", 40.0, 25.0, 16, 0, 0, 0, None),
    ("07", 65.2, 4.4, 1, 1000, 430, 0.50, "agent"),
    ("03", 16.0, 3.0, 1, 960, 400, 0.46, "two"),
    ("03", 27.2, 24.0, 16, 0, 0, 0, None),
    ("03", 51.3, 2.4, 1, 820, 560, 0.42, "two"),
    ("06", 11.5, 3.6, 1, 960, 390, 0.46, "batch"),
    ("06", 49.6, 28.8, 16, 0, 0, 0, None),
    ("06", 78.5, 2.4, 1, 680, 760, 0.72, "batch"),
]


def run(args: list[str]) -> None:
    proc = subprocess.run(args)
    if proc.returncode != 0:
        raise SystemExit(f"failed: {' '.join(args[:12])}")


def probe(path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(path),
        ],
        text=True,
    )
    return float(out.strip())


def x264(crf: str = "18") -> list[str]:
    return [
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(FPS),
        "-fps_mode",
        "cfr",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
        "-video_track_timescale",
        "30000",
        "-crf",
        crf,
        "-preset",
        "veryfast",
        "-threads",
        "1",
        "-x264-params",
        "aq-mode=3:aq-strength=1.2",
        "-movflags",
        "+faststart",
    ]


def motion(path: Path) -> list[tuple[float, float]]:
    """每 0.25 秒一帧的平均绝对差。缩小后再比较，避免整段 1080p 进内存。"""
    width, height = 160, 90
    raw = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"fps=4,scale={width}:{height},format=gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    frame = width * height
    prev = None
    samples: list[tuple[float, float]] = []
    for index in range(len(raw) // frame):
        buf = raw[index * frame : (index + 1) * frame]
        if prev is not None:
            diff = sum(abs(a - b) for a, b in zip(buf, prev, strict=True)) / frame
            samples.append((index / 4, diff))
        prev = buf
    return samples


def waits(samples: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    """低运动连续超过 3 秒视为等待。"""
    if not samples:
        return []
    values = sorted(diff for _, diff in samples)
    quiet = values[max(0, int(len(values) * 0.35))]
    threshold = max(1.2, min(quiet * 1.4, 4.5))
    spans: list[tuple[float, float]] = []
    start = None
    last = None
    for time, diff in samples:
        if diff < threshold:
            if start is None:
                start = time
            last = time
        elif start is not None:
            if last is not None and last - start >= 3:
                spans.append((start, last))
            start = None
            last = None
    if start is not None and last is not None and last - start >= 3:
        spans.append((start, min(duration, last + 0.25)))
    # 短于一拍的晃动不要把同一次等待切开，否则每段都会再留约 2 秒。
    merged: list[tuple[float, float]] = []
    for start, end in spans:
        if merged and start - merged[-1][1] < 1:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def compress(duration: float, spans: list[tuple[float, float]], reveal: float) -> list[tuple[float, float, float]]:
    """(start, end, speed)。等待段最多 16 倍，观感不超过约 2 秒。成果按原速保留。"""
    end_keep = min(duration, reveal + HOLD)
    pieces: list[tuple[float, float, float]] = []
    cursor = 0.0
    for start, end in spans:
        end = min(end, reveal)
        start = max(start, cursor)
        if end - start < 3:
            continue
        if start > cursor + 0.05:
            pieces.append((cursor, start, 1))
        span = end - start
        speed = min(16.0, max(8.0, span / 1.6))
        if span / speed > 2:
            speed = 16.0
            start = max(start, end - 32.0)
        pieces.append((start, end, speed))
        cursor = end
    if reveal - cursor > 0.05:
        pieces.append((cursor, reveal, 1))
    if end_keep - reveal > 0.05:
        pieces.append((reveal, end_keep, 1))
    return [piece for piece in pieces if piece[1] - piece[0] > 0.04]


def encode_span(src: Path, start: float, end: float, speed: float, dest: Path) -> None:
    """只解码这一小段。-ss 放在 -i 前面，避免六路同时解码整条母带。"""
    dur = end - start
    run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            str(src),
            "-vf",
            f"setpts=(PTS-STARTPTS)/{speed:.4f},fps={FPS},format=yuv420p",
            *x264(),
            str(dest),
        ]
    )


def concat(files: list[Path], dest: Path) -> None:
    listing = HD / "concat-list.txt"
    listing.write_text("".join(f"file '{file}'\n" for file in files), encoding="utf-8")
    proc = subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(dest)]
    )
    if proc.returncode == 0:
        return
    # 时间基不一致时退回滤镜拼接，仍然只压这一次成片。
    inputs: list[str] = []
    for file in files:
        inputs += ["-i", str(file)]
    labels = "".join(f"[{index}:v]" for index in range(len(files)))
    run(
        [
            "ffmpeg",
            "-y",
            *inputs,
            "-filter_complex",
            f"{labels}concat=n={len(files)}:v=1:a=0[v]",
            "-map",
            "[v]",
            *x264(),
            str(dest),
        ]
    )


def encode_webm(mp4: Path, dest: Path) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(mp4),
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "20",
            "-b:v",
            "0",
            "-cpu-used",
            "4",
            "-threads",
            "2",
            "-row-mt",
            "1",
            "-deadline",
            "good",
            str(dest),
        ]
    )


def poster(mp4: Path, dest: Path, at: float) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{max(0.2, at):.2f}",
            "-i",
            str(mp4),
            "-frames:v",
            "1",
            "-c:v",
            "libwebp",
            "-quality",
            "82",
            str(dest),
        ]
    )


def encode_guide(src: Path, pieces: list[tuple[float, float, float]], name: str) -> Path:
    work = HD / "guide-build" / name
    work.mkdir(parents=True, exist_ok=True)
    parts: list[Path] = []
    for index, (start, end, speed) in enumerate(pieces):
        part = work / f"{index:02d}.mp4"
        encode_span(src, start, end, speed, part)
        parts.append(part)
    mp4 = OUT / f"{name}.mp4"
    concat(parts, mp4)
    duration = probe(mp4)
    poster(mp4, OUT / f"{name}-poster.webp", duration - 0.6)
    return mp4


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size, index=FONT_INDEX)


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: tuple[int, int, int, int]) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def pill(text: str, size: int = 52) -> Image.Image:
    face = font(size)
    dummy = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    left, top, right, bottom = dummy.textbbox((0, 0), text, font=face)
    tw, th = right - left, bottom - top
    pad_x, pad_y = 36, 18
    image = Image.new("RGBA", (tw + pad_x * 2, th + pad_y * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    rounded(draw, (0, 0, image.width - 1, image.height - 1), 22, (12, 16, 14, 176))
    draw.text((pad_x - left, pad_y - top), text, font=face, fill=(255, 255, 255, 255))
    return image


def card(lines: list[tuple[str, int]], cta: str | None = None) -> Image.Image:
    image = Image.new("RGBA", (W, H), (17, 19, 17, 255))
    draw = ImageDraw.Draw(image)
    y = 390 if cta else 430
    for text, size in lines:
        face = font(size)
        dummy = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
        left, top, right, bottom = dummy.textbbox((0, 0), text, font=face)
        tw, th = right - left, bottom - top
        x = (W - tw) // 2
        draw.text((x - left + 2, y - top + 3), text, font=face, fill=(0, 0, 0, 90))
        draw.text((x - left, y - top), text, font=face, fill=(244, 245, 242, 255))
        y += th + 28
    if cta:
        face = font(36)
        dummy = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
        left, top, right, bottom = dummy.textbbox((0, 0), cta, font=face)
        tw, th = right - left, bottom - top
        bw, bh = tw + 72, th + 28
        x = (W - bw) // 2
        rounded(draw, (x, y, x + bw, y + bh), 18, (61, 107, 80, 255))
        draw.text((x + 36 - left, y + 14 - top), cta, font=face, fill=(255, 255, 255, 255))
    return image


def write_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


def zoom_filter(cx: int, cy: int, amount: float, dur: float) -> str:
    # 滤镜图里逗号要转义，否则 clip() 会被拆成多个滤镜。
    z = f"(1+{amount:.4f}*min(t/{max(dur, 0.1):.3f}\\,1))"
    return (
        f"crop=w='iw/{z}':h='ih/{z}':"
        f"x='clip({cx}-iw/{z}/2\\,0\\,iw-iw/{z})':"
        f"y='clip({cy}-ih/{z}/2\\,0\\,ih-ih/{z})',"
        f"scale={W}:{H}:flags=lanczos,setsar=1,format=yuv420p"
    )


def cut_scene(
    src: Path,
    start: float,
    dur: float,
    speed: float,
    cx: int,
    cy: int,
    zoom: float,
    dest: Path,
    sub: Path | None,
) -> None:
    if zoom > 0 and speed == 1:
        video = f"setpts=PTS-STARTPTS,fps={FPS},{zoom_filter(cx, cy, zoom, dur)}"
    else:
        video = f"setpts=(PTS-STARTPTS)/{speed:.4f},fps={FPS},setsar=1,format=yuv420p"
    cmd = ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    if sub is None:
        cmd += ["-vf", video, *x264(), str(dest)]
    else:
        play = dur / speed
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{play:.3f}", "-i", str(sub)]
        fade_out = max(0.3, play - 0.32)
        filt = (
            f"[0:v]{video}[base];"
            f"[1:v]format=rgba,fade=t=in:st=0:d=0.22:alpha=1,"
            f"fade=t=out:st={fade_out:.2f}:d=0.24:alpha=1[sub];"
            "[base][sub]overlay=x=(main_w-overlay_w)/2:"
            "y='main_h-overlay_h-78-16*(1-min(t/0.28\\,1))':format=yuv420[v]"
        )
        cmd += ["-filter_complex", filt, "-map", "[v]", *x264(), str(dest)]
    run(cmd)


def still_video(image: Path, dur: float, dest: Path) -> None:
    run(
        [
            "ffmpeg",
            "-y",
            "-loop",
            "1",
            "-framerate",
            str(FPS),
            "-i",
            str(image),
            "-t",
            f"{dur:.2f}",
            *x264(),
            str(dest),
        ]
    )


def build_guides(selected: dict[str, str] | None = None) -> None:
    for shot, name in (selected or GUIDE).items():
        src = HD / f"{shot}.mp4"
        if not src.exists():
            raise SystemExit(f"missing master {src}")
        duration = probe(src)
        if shot in MANUAL:
            pieces = MANUAL[shot]
            spans = []
        else:
            spans = waits(motion(src), duration)
            pieces = compress(duration, spans, REVEAL[shot])
        print(shot, "dur", round(duration, 1), "waits", [(round(a, 1), round(b, 1)) for a, b in spans])
        print(" ", [(round(a, 1), round(b, 1), round(s, 1)) for a, b, s in pieces])
        out = encode_guide(src, pieces, name)
        print(" ", name, "out", round(probe(out), 1), "MB", round(out.stat().st_size / 1048576, 2))


def build_promo() -> None:
    work = HD / "promo-build"
    work.mkdir(parents=True, exist_ok=True)
    write_png(card([("幕芽", 92), (SUBS["open"], 42)]), work / "title.png")
    write_png(card([("幕芽", 88), ("muvloom.online", 42)], cta="开始创作"), work / "end.png")
    agent = pill(SUBS["agent"])
    write_png(agent, work / "sub-agent.png")

    segments: list[Path] = []
    title_mp4 = work / "00-title.mp4"
    still_video(work / "title.png", 3.2, title_mp4)
    segments.append(title_mp4)

    for index, (shot, start, dur, speed, cx, cy, zoom, key) in enumerate(PROMO_SCENES, start=1):
        sub = None
        if key is not None:
            sub = work / f"sub-{index}.png"
            write_png(pill(SUBS[key]), sub)
        dest = work / f"{index:02d}.mp4"
        cut_scene(HD / f"{shot}.mp4", start, dur, speed, cx, cy, zoom, dest, sub)
        segments.append(dest)
        print("scene", index, shot, "at", start, "play", round(dur / speed, 2), "zoom", zoom)

    end_mp4 = work / "99-end.mp4"
    still_video(work / "end.png", 4.2, end_mp4)
    segments.append(end_mp4)

    promo = OUT / "promo-site-zh.mp4"
    concat(segments, promo)
    duration = probe(promo)
    size = promo.stat().st_size
    bitrate = size * 8 / duration / 1_000_000
    print(f"promo {duration:.2f}s {size / 1048576:.2f}MB {bitrate:.2f}Mbps")
    if not 45 <= duration <= 60:
        print("warning: duration outside 45–60")
    if size > 25 * 1048576:
        print("warning: larger than 25MB")
    poster(promo, OUT / "promo-site-zh-poster.webp", 8.0)
    (HD / "promo-report.json").write_text(
        json.dumps(
            {
                "seconds": round(duration, 2),
                "bytes": size,
                "mbps": round(bitrate, 2),
                "subtitles": [
                    "幕芽",
                    SUBS["open"],
                    SUBS["one"],
                    SUBS["ref"],
                    SUBS["agent"],
                    SUBS["two"],
                    SUBS["batch"],
                    "幕芽",
                    "muvloom.online",
                    "开始创作",
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def build_webm(names: list[str] | None = None) -> None:
    names = names if names is not None else [GUIDE[shot] for shot in GUIDE] + ["promo-site-zh"]
    for name in names:
        mp4 = OUT / f"{name}.mp4"
        webm = OUT / f"{name}.webm"
        print("webm", name)
        encode_webm(mp4, webm)


def build_inpaint() -> None:
    """09 的母带是两段：编辑器里的框选，和出片后的墨绿杯。"""
    spans = [
        (HD / "09-editor.mp4", 3.6, 6.0, 1),
        (HD / "09-editor.mp4", 11.2, 18.6, 1),
        (HD / "09-editor.mp4", 19.6, 22.4, 1),
        (HD / "09-result.mp4", 7.0, 9.4, 1),
    ]
    work = HD / "guide-build" / "09-inpaint"
    work.mkdir(parents=True, exist_ok=True)
    parts: list[Path] = []
    for index, (src, start, end, speed) in enumerate(spans):
        part = work / f"{index:02d}.mp4"
        encode_span(src, start, end, speed, part)
        parts.append(part)
    mp4 = OUT / "09-inpaint.mp4"
    concat(parts, mp4)
    duration = probe(mp4)
    poster(mp4, OUT / "09-inpaint-poster.webp", duration - 0.5)
    print("09-inpaint", round(duration, 2), "MB", round(mp4.stat().st_size / 1048576, 2))
    encode_webm(mp4, OUT / "09-inpaint.webm")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:]
    if only == ["09"]:
        build_inpaint()
        return
    if only:
        selected = {shot: GUIDE[shot] for shot in only}
        build_guides(selected)
        build_webm([GUIDE[shot] for shot in only])
        return
    build_guides()
    build_promo()
    build_webm()


if __name__ == "__main__":
    main()
