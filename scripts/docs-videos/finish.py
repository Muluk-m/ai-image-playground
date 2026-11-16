#!/usr/bin/env python3
"""从 1080p 母带剪指南成片。

等待段 8–16 倍快进，只留约两秒，CRF 18，无营销字幕。宣传片不在这里剪，见同目录 README.md。
母带在 scripts/docs-videos/raw/hd/。不要用已经压过的成片当输入。

mp4 / webm 写到 scripts/docs-videos/out/（gitignore）。封面 webp 仍写到
apps/web/public/guide-assets/zh/clips/。上线方式见同目录 README.md。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HD = ROOT / "scripts/docs-videos/raw/hd"
# 成片不进仓库。封面仍给页面做 poster，路径保持 /guide-assets/zh/clips/。
OUT = ROOT / "scripts/docs-videos/out"
POSTERS = ROOT / "apps/web/public/guide-assets/zh/clips"
FPS = 30

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
    poster(mp4, POSTERS / f"{name}-poster.webp", duration - 0.6)
    return mp4


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


def build_webm(names: list[str] | None = None) -> None:
    names = names if names is not None else [GUIDE[shot] for shot in GUIDE]
    for name in names:
        mp4 = OUT / f"{name}.mp4"
        webm = OUT / f"{name}.webm"
        print("webm", name)
        encode_webm(mp4, webm)


def build_video() -> None:
    """08：首页提交、画布文生视频、生成中，然后是成片播放。"""
    spans = [
        (HD / "08-gen.mp4", 5.4, 8.2, 1),
        (HD / "08-gen.mp4", 15.2, 17.6, 1),
        (HD / "08-gen.mp4", 34.6, 38.4, 1),
        (HD / "08-gen.mp4", 42.0, 70.0, 16),
        (HD / "08-gen.mp4", 74.4, 77.2, 1),
        (HD / "08-play.mp4", 6.6, 11.3, 1),
    ]
    work = HD / "guide-build" / "08-video"
    work.mkdir(parents=True, exist_ok=True)
    parts: list[Path] = []
    for index, (src, start, end, speed) in enumerate(spans):
        part = work / f"{index:02d}.mp4"
        encode_span(src, start, end, speed, part)
        parts.append(part)
    mp4 = OUT / "08-video.mp4"
    concat(parts, mp4)
    duration = probe(mp4)
    poster(mp4, POSTERS / "08-video-poster.webp", max(0.4, duration - 1.2))
    print("08-video", round(duration, 2), "MB", round(mp4.stat().st_size / 1048576, 2))
    encode_webm(mp4, OUT / "08-video.webm")


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
    poster(mp4, POSTERS / "09-inpaint-poster.webp", duration - 0.5)
    print("09-inpaint", round(duration, 2), "MB", round(mp4.stat().st_size / 1048576, 2))
    encode_webm(mp4, OUT / "09-inpaint.webm")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    POSTERS.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:]
    if only == ["08"]:
        build_video()
        return
    if only == ["09"]:
        build_inpaint()
        return
    if only:
        selected = {shot: GUIDE[shot] for shot in only}
        build_guides(selected)
        build_webm([GUIDE[shot] for shot in only])
        return
    build_guides()
    build_webm()


if __name__ == "__main__":
    main()
