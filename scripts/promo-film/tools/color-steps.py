"""每 0.5 秒统计画面里饱和像素的占比，占比跳变的时刻就是成图出现在界面上的时刻。

用法: python3 tools/color-steps.py raw/batch.mp4
"""

import subprocess
import sys

import numpy as np

W, H = 288, 162

if len(sys.argv) != 2:
    sys.exit(__doc__)
path = sys.argv[1]
proc = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps=2,scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    capture_output=True,
)
frame_bytes = W * H * 3
if proc.returncode != 0 or len(proc.stdout) < frame_bytes:
    sys.exit(f"无法解码 {path}：{proc.stderr.decode(errors='replace').strip() or '没有输出帧'}")

frames = np.frombuffer(proc.stdout[: len(proc.stdout) // frame_bytes * frame_bytes], np.uint8)
frames = frames.reshape(-1, H, W, 3).astype(int)
saturated = (frames.max(3) - frames.min(3) > 60).mean((1, 2))
prev = 0.0
for i, share in enumerate(saturated):
    if abs(share - prev) > 0.002:
        print(f"{i / 2:6.1f}s  sat={share:.3f}")
    prev = share
