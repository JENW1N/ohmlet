#!/usr/bin/env python3
"""Assemble the ohmlet demo video from recorded scene clips.

Reads demo/out/marks.json (written by record-scenes.mjs), cuts each scene
to the 117 BPM bar grid, burns caption PNGs with alpha fades, punches in
where the storyboard calls for it, and muxes the procedural soundtrack.

Usage: python3 demo/assemble.py [--only segNN]
"""
import json, math, subprocess, sys, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = f"{ROOT}/demo/out"
SEG = f"{OUT}/segs"
CARDS = f"{OUT}/cards"
MUSIC = "/private/tmp/claude-501/-Users-john-arc/a5b06677-b1c3-4db4-a1f4-93c0ab1ce068/scratchpad/video/soundtrack.wav"
FINAL = f"{OUT}/ohmlet-demo.mp4"
os.makedirs(SEG, exist_ok=True)

BPM = 117.0
BAR = 240.0 / BPM  # 2.05128s
FPS = 30

marks = json.load(open(f"{OUT}/marks.json"))
def M(scene, label):
    return marks[scene]["boot"] + marks[scene][label]

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:]); sys.exit(f"FAILED: {' '.join(cmd[:8])}…")

def probe_dur(path):
    r = subprocess.run(["ffprobe","-v","quiet","-show_entries","format=duration",
                        "-of","csv=p=0",path],capture_output=True,text=True)
    return float(r.stdout.strip())

def led_on_time(clip, after, crop="200:200:610:140"):
    """first sustained luminance jump in the LED crop region after `after`."""
    r = subprocess.run(["ffmpeg","-hide_banner","-i",clip,"-vf",
        f"crop={crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-f","null","-"],capture_output=True,text=True)
    frames = []
    t = None
    for line in r.stderr.splitlines():
        m = re.search(r"pts_time:([0-9.]+)", line)
        if m: t = float(m.group(1))
        m = re.search(r"YAVG=([0-9.]+)", line)
        if m and t is not None: frames.append((t, float(m.group(1))))
    base = min(y for tt, y in frames if tt >= after) if frames else 0
    for i, (tt, y) in enumerate(frames):
        if tt < after: continue
        if y > base + 8:  # LED glow bumps the crop's average strongly
            return tt
    raise SystemExit("LED on-time not found")

def seg_from_clip(name, clip, cuts, caption=None, dur=None, punch=None):
    """cuts: list of (start, end, speed). caption: card png. punch: (z0,z1)."""
    total = sum((e - s) / sp for s, e, sp in cuts)
    dur = dur or total
    parts, filters, concat_in = [], [], ""
    for i, (s, e, sp) in enumerate(cuts):
        filters.append(
            f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=(PTS-STARTPTS)/{sp}[c{i}]")
        concat_in += f"[c{i}]"
    filters.append(f"{concat_in}concat=n={len(cuts)}:v=1:a=0[cat]")
    chain = "[cat]"
    if punch:
        z0, z1 = punch
        n = int(dur * FPS)
        filters.append(
            f"{chain}scale=3840:2160,zoompan=z='{z0}+({z1}-{z0})*on/{n}':d=1:"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps={FPS}[z]")
        chain = "[z]"
    filters.append(f"{chain}scale=1920:1080,fps={FPS},format=yuv420p[v0]")
    chain = "[v0]"
    cmd = ["ffmpeg","-hide_banner","-loglevel","error","-y","-i",clip]
    if caption:
        cmd += ["-loop","1","-t",f"{dur:.3f}","-i",f"{CARDS}/{caption}.png"]
        fo = max(0.0, dur - 0.42)
        filters.append(
            f"[1:v]format=rgba,fade=in:st=0.12:d=0.28:alpha=1,"
            f"fade=out:st={fo:.3f}:d=0.3:alpha=1[cap]")
        filters.append(f"{chain}[cap]overlay=0:0[v]")
        chain = "[v]"
    cmd += ["-filter_complex",";".join(filters),"-map",chain if chain=="[v]" else chain,
            "-t",f"{dur:.3f}","-r",str(FPS),"-c:v","libx264","-crf","17","-preset","medium",
            "-pix_fmt","yuv420p",f"{SEG}/{name}.mp4"]
    run(cmd)
    print(f"{name}: {dur:.2f}s")

def seg_from_still(name, png, dur, caption=None, zoom=(1.0, 1.05), blur=None, fadein=0, fadeout=0):
    n = int(dur * FPS)
    pre = f"scale=3840:2160"
    if blur: pre += f",gblur=sigma={blur}"
    filters = [
        f"[0:v]{pre},zoompan=z='{zoom[0]}+({zoom[1]}-{zoom[0]})*on/{n}':d={n}:"
        f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps={FPS},format=yuv420p[v0]"]
    chain = "[v0]"
    cmd = ["ffmpeg","-hide_banner","-loglevel","error","-y","-loop","1","-t",f"{dur:.3f}","-i",png]
    if caption:
        cmd += ["-loop","1","-t",f"{dur:.3f}","-i",f"{CARDS}/{caption}.png"]
        filters.append(f"[1:v]format=rgba,fade=in:st=0.15:d=0.3:alpha=1[cap]")
        filters.append(f"{chain}[cap]overlay=0:0[vc]")
        chain = "[vc]"
    fx = []
    if fadein: fx.append(f"fade=in:st=0:d={fadein}")
    if fadeout: fx.append(f"fade=out:st={dur-fadeout:.3f}:d={fadeout}")
    if fx:
        filters.append(f"{chain}{','.join(fx)}[vf]")
        chain = "[vf]"
    cmd += ["-filter_complex",";".join(filters),"-map",chain,
            "-t",f"{dur:.3f}","-r",str(FPS),"-c:v","libx264","-crf","17","-preset","medium",
            "-pix_fmt","yuv420p",f"{SEG}/{name}.mp4"]
    run(cmd)
    print(f"{name}: {dur:.2f}s")

only = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--only" else None
def want(n): return only is None or only == n

# --------------------------------------------------------------- segments
# S1 — the photo hook (converged still, Ken Burns push)
if want("seg01"):
    seg_from_still("seg01", f"{OUT}/still_pose_a.png", BAR * 1, caption="c01_not_a_photo",
                   zoom=(1.0, 1.06))

# S2 — live reveal at the same pose, sim running + orbit drag
if want("seg02"):
    t = M("live_reveal", "run") + 0.25
    seg_from_clip("seg02", f"{OUT}/live_reveal.webm", [(t, t + BAR, 1.0)],
                  caption="c02_live")

# S3 — hologram placements: 555 ghost+snap, LED snap, resistor snap
if want("seg03"):
    c555 = M("build", "placeLED") - 0.60   # click ≈ 0.6s before next phase mark
    cled = M("build", "placeR") - 0.60
    # resistor's second-hole click ≈ placeR + panel(1.3) + hole1(1.75) + hole2(1.05)
    cres = M("build", "placeR") + 4.10
    seg_from_clip("seg03", f"{OUT}/build.webm",
                  [(c555 - 0.80, c555 + 0.25, 1.0),
                   (cled - 0.30, cled + 0.20, 1.0),
                   (cres - 0.30, cres + 0.21, 1.0)],
                  caption="c03_parts", dur=BAR)

# S4 — wires route themselves
if want("seg04"):
    w1 = M("wires", "wire1")
    w2 = M("wires", "wire2")
    seg_from_clip("seg04", f"{OUT}/wires.webm",
                  [(w1 + 0.55, w1 + 2.30, 1.25),
                   (w2 + 1.30, w2 + 2.25, 1.5)],
                  caption="c04_wires", dur=BAR)

# S5 — it's alive: first blink on the downbeat, punch-in
if want("seg05"):
    on = led_on_time(f"{OUT}/run_blink.webm", M("run_blink", "run"))
    seg_from_clip("seg05", f"{OUT}/run_blink.webm", [(on - 0.10, on - 0.10 + BAR, 1.0)],
                  caption="c05_alive", punch=(1.0, 1.13))

# S6 — the scope
if want("seg06"):
    t = M("scope", "scope") + 0.55
    seg_from_clip("seg06", f"{OUT}/scope.webm", [(t, t + BAR, 1.0)], caption="c06_scope")

# S7 — describe it (typing, 2x)
if want("seg07"):
    t = M("ai", "type") + 0.15
    seg_from_clip("seg07", f"{OUT}/ai.webm", [(t, t + 2 * BAR, 2.0)], caption="c07_describe")

# S8 — Claude builds it (verified card → apply → counting digits)
if want("seg08"):
    v = M("ai", "verified"); a = M("ai", "apply"); p = M("ai", "pushin")
    seg_from_clip("seg08", f"{OUT}/ai.webm",
                  [(v + 0.10, v + 0.80, 1.0),
                   (a + 0.15, a + 1.15, 1.0),
                   (p + 0.80, p + 2.20, 1.0)],
                  caption="c08_ai", dur=BAR * 1.5)

# S9 — grow the bench (3.2x)
if want("seg09"):
    g = M("bench", "grow1"); s = M("bench", "settle")
    seg_from_clip("seg09", f"{OUT}/bench.webm", [(g, s + 0.6, (s + 0.6 - g) / BAR)],
                  caption="c09_bench", dur=BAR)

# S10 — date-display orbit (1.5 bars)
if want("seg10"):
    o = M("date_orbit", "orbit") + 0.30
    span = 5.7
    seg_from_clip("seg10", f"{OUT}/date_orbit.webm", [(o, o + span, span / (BAR * 1.5))],
                  caption="c10_date", dur=BAR * 1.5)

# S11 — glass lensing beauty (riser bar)
if want("seg11"):
    g = M("lens", "glide") + 0.40
    span = 4.5
    seg_from_clip("seg11", f"{OUT}/lens.webm", [(g, g + span, span / BAR)],
                  caption="c11_glass", dur=BAR)

# S12 — THE DROP: noise → converged still (timelapse), hold
if want("seg12"):
    b = marks["converge"]["boot"]
    conv = M("converge", "converged")
    noise0 = b + 0.75
    dur12 = 29.0 - (12 * BAR)  # from bar 12 to 29.0s
    lapse = dur12 - 0.5 - 1.1  # realtime noise 0.5s + hold 1.1s
    seg_from_clip("seg12", f"{OUT}/converge.webm",
                  [(noise0, noise0 + 0.5, 1.0),
                   (noise0 + 0.5, conv + 0.05, (conv + 0.05 - noise0 - 0.5) / lapse),
                   (conv + 0.1, conv + 1.2, 1.0)],
                  caption="c12_pathtraced", dur=dur12)

# S13 — end card over the blurred converged still
if want("seg13"):
    seg_from_still("seg13", f"{OUT}/still_pose_a.png", 33.0 - 29.0,
                   caption="c13_end", zoom=(1.08, 1.13), blur=24, fadein=0.001, fadeout=0.55)

# --------------------------------------------------------------- concat + audio
if only is None:
    segs = [f"seg{i:02d}" for i in range(1, 14)]
    with open(f"{SEG}/list.txt", "w") as f:
        for s in segs:
            f.write(f"file '{SEG}/{s}.mp4'\n")
    run(["ffmpeg","-hide_banner","-loglevel","error","-y","-f","concat","-safe","0",
         "-i",f"{SEG}/list.txt","-i",MUSIC,
         "-map","0:v","-map","1:a","-c:v","copy","-c:a","aac","-b:a","192k",
         "-shortest","-movflags","+faststart",FINAL])
    print(f"\nFINAL: {FINAL}  ({probe_dur(FINAL):.2f}s)")
