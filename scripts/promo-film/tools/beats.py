import subprocess, sys, numpy as np, json
SR=22050; hop=256
p=sys.argv[1]
x=np.frombuffer(subprocess.run(['ffmpeg','-v','error','-i',p,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout,np.float32)
fr=np.lib.stride_tricks.sliding_window_view(x,2048)[::hop]
spec=np.abs(np.fft.rfft(fr*np.hanning(2048),axis=1))
flux=np.maximum(0,np.diff(np.log1p(spec),axis=0)).sum(1); fps=SR/hop
t=np.arange(len(flux))/fps
best=None
for bpm in np.arange(78,84,0.05):
    per=60/bpm
    for ph in np.arange(0,per,0.01):
        idx=((np.arange(ph,t[-1],per))*fps).astype(int)
        s=flux[idx].mean()
        if best is None or s>best[0]: best=(s,bpm,ph)
s,bpm,ph=best
print(f"bpm={bpm:.2f} phase={ph:.3f}s period={60/bpm:.4f}")
rms=[np.sqrt(np.mean(x[int(i*SR):int((i+1)*SR)]**2)) for i in range(int(len(x)/SR))]
print("last 20s dB/1s:", ' '.join(f"{20*np.log10(v+1e-9):.0f}" for v in rms[-20:]))
print("first 8s dB/1s:", ' '.join(f"{20*np.log10(v+1e-9):.0f}" for v in rms[:8]))
