# 每 0.5 秒统计画面饱和像素占比，用来找成图出现的时刻
import subprocess, sys, numpy as np
p, w, h = sys.argv[1], 288, 162
raw = subprocess.run(['ffmpeg','-v','error','-i',p,'-vf',f'fps=2,scale={w}:{h}','-f','rawvideo','-pix_fmt','rgb24','-'],capture_output=True).stdout
f = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(int)
sat = (f.max(3) - f.min(3) > 60).mean((1, 2))
prev = 0
for i, s in enumerate(sat):
    if abs(s - prev) > 0.002: print(f"{i/2:6.1f}s  sat={s:.3f}")
    prev = s
