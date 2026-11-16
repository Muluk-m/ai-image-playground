"""估算配乐的 BPM 和第一拍位置，并打印开头与结尾的逐秒响度，用来排剪辑点和找曲尾收束。

用法: python3 tools/beats.py public/music/warm-guitar.mp3 [最低BPM 最高BPM]（默认 60 140）
"""

import subprocess
import sys

import numpy as np

SR = 22050
HOP = 256
WINDOW = 2048

if len(sys.argv) not in (2, 4):
    sys.exit(__doc__)
path = sys.argv[1]
low, high = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) == 4 else (60.0, 140.0)

proc = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
    capture_output=True,
)
if proc.returncode != 0:
    sys.exit(f"无法解码 {path}：{proc.stderr.decode(errors='replace').strip()}")
x = np.frombuffer(proc.stdout[: len(proc.stdout) // 4 * 4], np.float32)
if len(x) < SR * 4:
    sys.exit(f"{path} 不足 4 秒，没法估节拍")

frames = np.lib.stride_tricks.sliding_window_view(x, WINDOW)[::HOP]
spec = np.abs(np.fft.rfft(frames * np.hanning(WINDOW), axis=1))
flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(1)
fps = SR / HOP
end = len(flux) / fps

# 在拍长和相位上网格搜索，取拍点上起音强度均值最大的组合
best = (-1.0, 0.0, 0.0)
for bpm in np.arange(low, high, 0.05):
    period = 60 / bpm
    for phase in np.arange(0, period, 0.01):
        idx = (np.arange(phase, end, period) * fps).astype(int)
        score = flux[idx[idx < len(flux)]].mean()
        if score > best[0]:
            best = (score, bpm, phase)
_, bpm, phase = best
print(f"bpm={bpm:.2f} phase={phase:.3f}s period={60 / bpm:.4f}")

db = [20 * np.log10(np.sqrt(np.mean(x[i * SR : (i + 1) * SR] ** 2)) + 1e-9) for i in range(len(x) // SR)]
print("first 8s dB/1s:", " ".join(f"{v:.0f}" for v in db[:8]))
print("last 20s dB/1s:", " ".join(f"{v:.0f}" for v in db[-20:]))
